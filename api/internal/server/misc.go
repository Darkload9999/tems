package server

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
)

/* ---------- me + stats ---------- */

func (s *Server) me(c *call) error {
	perms := []string{}
	for p := range c.P.Perms {
		perms = append(perms, p)
	}
	sort.Strings(perms)
	return c.JSON(200, map[string]any{
		"id": c.P.ID, "username": c.P.Username, "name": c.P.Name, "email": c.P.Email,
		"superAdmin": c.P.Super, "permissions": perms, "groups": nz(c.P.Groups),
	})
}

func (s *Server) stats(c *call) error {
	if err := c.need("dashboard:view"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	active, custom := 0, 0
	for _, u := range sn.Users {
		if u.Enabled {
			active++
		}
	}
	for _, r := range sn.Perms {
		if r.Attr("system") != "true" {
			custom++
		}
	}
	queued, sent24, failed, err := s.st.MailCounts(c.ctx())
	if err != nil {
		return err
	}
	sessions := 0
	var stats []map[string]any
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/client-session-stats", nil, &stats); err == nil {
		for _, st := range stats {
			n, _ := strconv.Atoi(fmt.Sprint(st["active"]))
			sessions += n
		}
	}
	return c.JSON(200, map[string]int{
		"users": len(sn.Users), "activeUsers": active, "disabledUsers": len(sn.Users) - active,
		"groups": len(sn.Groups), "permissions": len(sn.Perms), "customPermissions": custom,
		"mailSent24h": sent24, "mailFailed": failed, "mailQueued": queued,
		"sessions": sessions, "superAdmins": len(sn.Supers),
	})
}

/* ---------- mail ---------- */

func (s *Server) listMail(c *call) error {
	if err := c.need("mail:view"); err != nil {
		return err
	}
	page, size := c.paging(12)
	items, total, err := s.st.ListMail(c.ctx(), c.query("search"), c.query("status"), page, size)
	if err != nil {
		return err
	}
	return c.JSON(200, map[string]any{"items": items, "total": total})
}

func (s *Server) getMail(c *call) error {
	if err := c.need("mail:view"); err != nil {
		return err
	}
	m, err := s.st.GetMail(c.ctx(), c.param("id"))
	if err != nil {
		return err
	}
	return c.JSON(200, m)
}

func (s *Server) resendMail(c *call) error {
	if err := c.need("mail:manage"); err != nil {
		return err
	}
	m, err := s.st.GetMail(c.ctx(), c.param("id"))
	if err != nil {
		return err
	}
	if err := s.st.Requeue(c.ctx(), m.ID); err != nil {
		return err
	}
	s.mailer.Kick()
	c.audit("mail.resend", "mail", m.ID, m.To, "Re-queued “"+m.Subject+"” to "+m.To, nil)
	m, _ = s.st.GetMail(c.ctx(), m.ID)
	return c.JSON(200, m)
}

func (s *Server) deleteMail(c *call) error {
	if err := c.need("mail:manage"); err != nil {
		return err
	}
	m, err := s.st.GetMail(c.ctx(), c.param("id"))
	if err != nil {
		return err
	}
	if err := s.st.DeleteMail(c.ctx(), m.ID); err != nil {
		return err
	}
	c.audit("mail.delete", "mail", m.ID, m.To, "Deleted “"+m.Subject+"” to "+m.To, nil)
	return c.NoContent()
}

func (s *Server) compose(c *call) error {
	if err := c.need("mail:send"); err != nil {
		return err
	}
	var in struct {
		UserIDs  []string `json:"userIds"`
		GroupIDs []string `json:"groupIds"`
		Subject  string   `json:"subject"`
		Message  string   `json:"message"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	in.Subject, in.Message = strings.TrimSpace(in.Subject), strings.TrimSpace(in.Message)
	if in.Subject == "" || len(in.Subject) > 200 {
		return errf(400, "Add a subject (up to 200 characters).")
	}
	if len(in.Message) < 2 || len(in.Message) > 20000 {
		return errf(400, "Write a message (up to 20,000 characters).")
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	ids := map[string]bool{}
	for _, id := range in.UserIDs {
		ids[id] = true
	}
	var groupNames []string
	for _, gid := range in.GroupIDs {
		if g := sn.GroupByID[gid]; g != nil {
			groupNames = append(groupNames, g.Name)
			for _, m := range g.Members {
				ids[m] = true
			}
		}
	}
	var recipients []*kc.User
	for _, u := range sn.Users {
		if ids[u.ID] && u.Enabled {
			recipients = append(recipients, u)
		}
	}
	if len(recipients) == 0 {
		return errf(400, "Choose at least one active recipient.")
	}
	c.notify("mail.direct", recipients, func(*kc.User) tmail.Data { return tmail.Data{Subject: in.Subject, Message: in.Message} }, true)
	n := c.notified
	c.audit("mail.compose", "mail", "", fmt.Sprintf("%d recipient%s", n, plural(n)),
		fmt.Sprintf("Sent “%s” to %d recipient%s", in.Subject, n, plural(n)), map[string]any{"users": len(in.UserIDs), "groups": groupNames})
	c.notified = 0 // the console reports its own count for direct messages
	return c.JSON(200, map[string]int{"queued": n})
}

func (s *Server) mailHealth(c *call) error {
	if err := c.need("mail:view"); err != nil {
		return err
	}
	h := s.mailer.Health(c.ctx())
	h.Queue, _, _, _ = s.st.MailCounts(c.ctx())
	return c.JSON(200, h)
}

/* ---------- audit ---------- */

func (s *Server) listAudit(c *call) error {
	if err := c.need("audit:view"); err != nil {
		return err
	}
	page, size := c.paging(15)
	items, total, err := s.st.ListAudit(c.ctx(), c.query("search"), c.query("targetType"), page, size)
	if err != nil {
		return err
	}
	return c.JSON(200, map[string]any{"items": items, "total": total})
}

/* ---------- settings ---------- */

type Settings struct {
	OrgName            string          `json:"orgName"`
	MailFromName       string          `json:"mailFromName"`
	MailFrom           string          `json:"mailFrom"`
	ReplyTo            string          `json:"replyTo"`
	Notifications      map[string]bool `json:"notifications"`
	SessionIdleMinutes int             `json:"sessionIdleMinutes"`
	PasswordMinLength  int             `json:"passwordMinLength"`
}

func (s *Server) defaults() Settings {
	n := map[string]bool{}
	for _, e := range tmail.Events {
		n[e] = true
	}
	return Settings{
		OrgName: "Techzaz Networks", MailFromName: s.cfg.MailFromName, MailFrom: s.cfg.MailFrom, ReplyTo: "soc@techzaz.lk",
		Notifications: n, SessionIdleMinutes: 30, PasswordMinLength: 10,
	}
}

// LoadSettings reads stored settings (or seeds defaults) at startup.
func (s *Server) LoadSettings(ctx context.Context) error {
	st := s.defaults()
	found, err := s.st.LoadSettings(ctx, &st)
	if err != nil {
		return err
	}
	for _, e := range tmail.Events { // events added in newer versions default to on
		if _, ok := st.Notifications[e]; !ok {
			st.Notifications[e] = true
		}
	}
	if !found {
		if err := s.st.SaveSettings(ctx, st); err != nil {
			return err
		}
	}
	s.setMu.Lock()
	s.settings = st
	s.setMu.Unlock()
	return nil
}

func (s *Server) Settings() Settings {
	s.setMu.RLock()
	defer s.setMu.RUnlock()
	return s.settings
}

// MailIdentity is the sender used by the mail worker.
func (s *Server) MailIdentity(context.Context) tmail.Identity {
	st := s.Settings()
	return tmail.Identity{From: st.MailFrom, FromName: st.MailFromName, ReplyTo: st.ReplyTo}
}

var policyLen = regexp.MustCompile(`length\((\d+)\)`)

func (s *Server) getSettings(c *call) error {
	if err := c.need("settings:manage", "mail:manage"); err != nil {
		return err
	}
	st := s.Settings()
	// reflect the realm's actual values
	var realm struct {
		SSOSessionIdleTimeout int    `json:"ssoSessionIdleTimeout"`
		PasswordPolicy        string `json:"passwordPolicy"`
	}
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "", nil, &realm); err == nil {
		if realm.SSOSessionIdleTimeout > 0 {
			st.SessionIdleMinutes = realm.SSOSessionIdleTimeout / 60
		}
		if m := policyLen.FindStringSubmatch(realm.PasswordPolicy); m != nil {
			st.PasswordMinLength, _ = strconv.Atoi(m[1])
		}
	}
	return c.JSON(200, st)
}

func (s *Server) saveSettings(c *call) error {
	if err := c.need("settings:manage"); err != nil {
		return err
	}
	var in Settings
	if err := c.decode(&in); err != nil {
		return err
	}
	in.MailFrom, in.ReplyTo = strings.TrimSpace(in.MailFrom), strings.TrimSpace(in.ReplyTo)
	if !validEmail(in.MailFrom) || !strings.HasSuffix(strings.ToLower(in.MailFrom), "@"+strings.ToLower(s.cfg.MailDomain)) {
		return errf(400, "The sender address must be on %s (the domain the mail server signs for).", s.cfg.MailDomain)
	}
	if in.ReplyTo != "" && !validEmail(in.ReplyTo) {
		return errf(400, "Enter a valid reply-to address.")
	}
	if in.PasswordMinLength < 8 || in.PasswordMinLength > 64 {
		return errf(400, "Minimum password length must be between 8 and 64.")
	}
	if in.SessionIdleMinutes < 5 || in.SessionIdleMinutes > 1440 {
		return errf(400, "Session idle timeout must be between 5 and 1440 minutes.")
	}
	if strings.TrimSpace(in.MailFromName) == "" {
		return errf(400, "Add a sender name.")
	}
	clean := s.defaults()
	for k := range clean.Notifications {
		if v, ok := in.Notifications[k]; ok {
			clean.Notifications[k] = v
		}
	}
	clean.Notifications["mail.direct"] = true
	clean.OrgName, clean.MailFromName, clean.MailFrom, clean.ReplyTo = strings.TrimSpace(in.OrgName), strings.TrimSpace(in.MailFromName), in.MailFrom, in.ReplyTo
	clean.SessionIdleMinutes, clean.PasswordMinLength = in.SessionIdleMinutes, in.PasswordMinLength

	realm := map[string]any{
		"ssoSessionIdleTimeout": clean.SessionIdleMinutes * 60,
		"passwordPolicy":        fmt.Sprintf("length(%d) and digits(1) and upperCase(1) and lowerCase(1) and notUsername(undefined)", clean.PasswordMinLength),
		"smtpServer": map[string]string{
			"host": s.cfg.SMTPHost, "port": s.cfg.SMTPPort, "from": clean.MailFrom, "fromDisplayName": clean.MailFromName,
			"replyTo": clean.ReplyTo, "auth": "false", "ssl": "false", "starttls": "false",
		},
	}
	if _, err := s.kc.Do(c.ctx(), http.MethodPut, "", realm, nil); err != nil {
		return err
	}
	old := s.Settings()
	if err := s.st.SaveSettings(c.ctx(), clean); err != nil {
		return err
	}
	s.setMu.Lock()
	s.settings = clean
	s.setMu.Unlock()

	var changed []string
	if old.OrgName != clean.OrgName || old.MailFromName != clean.MailFromName || old.MailFrom != clean.MailFrom || old.ReplyTo != clean.ReplyTo {
		changed = append(changed, "sender")
	}
	if old.SessionIdleMinutes != clean.SessionIdleMinutes || old.PasswordMinLength != clean.PasswordMinLength {
		changed = append(changed, "security policy")
	}
	for k, v := range clean.Notifications {
		if old.Notifications[k] != v {
			changed = append(changed, "notifications")
			break
		}
	}
	if len(changed) > 0 {
		c.audit("settings.update", "settings", "settings", "System settings", "Updated "+strings.Join(changed, ", "), map[string]any{"changed": changed})
	}
	return c.JSON(200, clean)
}
