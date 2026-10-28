package server

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
)

/* ---------- email signatures + mailbox settings ---------- */

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func cleanSignatures(in []tmail.Signature) ([]tmail.Signature, error) {
	if len(in) > 20 {
		return nil, errf(400, "Keep it to 20 signatures or fewer.")
	}
	out := []tmail.Signature{}
	seen := map[string]bool{}
	for _, s := range in {
		s.Name, s.Title, s.Email = strings.TrimSpace(s.Name), strings.TrimSpace(s.Title), strings.TrimSpace(s.Email)
		s.Phone, s.Web = strings.TrimSpace(s.Phone), strings.TrimSpace(s.Web)
		if s.Name == "" {
			return nil, errf(400, "Every signature needs a name.")
		}
		if s.Email != "" && !validEmail(s.Email) {
			return nil, errf(400, "Enter a valid email address for %s.", s.Name)
		}
		for _, v := range []string{s.Name, s.Title, s.Email, s.Phone, s.Web} {
			if len(v) > 120 {
				return nil, errf(400, "Signature fields are limited to 120 characters.")
			}
		}
		id := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(strings.TrimSpace(s.ID)), "-"), "-")
		if id == "" {
			id = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s.Name), "-"), "-")
		}
		for base, n := id, 2; seen[id]; n++ {
			id = fmt.Sprintf("%s-%d", base, n)
		}
		seen[id] = true
		s.ID = id
		out = append(out, s)
	}
	return out, nil
}

var hostRe = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)
var securities = map[string]bool{"SSL/TLS": true, "STARTTLS": true, "None": true}

func cleanMailbox(m tmail.Mailbox) (tmail.Mailbox, error) {
	m.IncomingHost, m.OutgoingHost, m.Webmail = strings.TrimSpace(m.IncomingHost), strings.TrimSpace(m.OutgoingHost), strings.TrimSpace(m.Webmail)
	if !hostRe.MatchString(m.IncomingHost) || !hostRe.MatchString(m.OutgoingHost) {
		return m, errf(400, "Enter valid incoming and outgoing mail server host names.")
	}
	if m.IncomingPort < 1 || m.IncomingPort > 65535 || m.OutgoingPort < 1 || m.OutgoingPort > 65535 {
		return m, errf(400, "Mail server ports must be between 1 and 65535.")
	}
	if !securities[m.IncomingSecurity] || !securities[m.OutgoingSecurity] {
		return m, errf(400, "Encryption must be SSL/TLS, STARTTLS or None.")
	}
	if len(m.Webmail) > 200 {
		return m, errf(400, "The webmail address is too long.")
	}
	return m, nil
}

// listSignatures lets anyone who sends mail pick a signature in Compose.
func (s *Server) listSignatures(c *call) error {
	if err := c.need("mail:send", "mail:manage", "settings:manage"); err != nil {
		return err
	}
	st := s.Settings()
	return c.JSON(200, map[string]any{"signatures": st.Signatures, "signatureFor": st.SignatureFor, "signatureFooter": st.SignatureFooter})
}

/* ---------- personal email + Outlook setup (super admins) ---------- */

func (s *Server) mailboxSetup(c *call) error {
	if err := c.needSuper(); err != nil {
		return err
	}
	var in struct {
		PersonalEmail string `json:"personalEmail"`
		Note          string `json:"note"`
		Send          bool   `json:"send"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	in.PersonalEmail, in.Note = strings.TrimSpace(in.PersonalEmail), strings.TrimSpace(in.Note)
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if in.PersonalEmail != "" && !validEmail(in.PersonalEmail) {
		return errf(400, "Enter a valid personal email address.")
	}
	if in.PersonalEmail != "" && strings.EqualFold(in.PersonalEmail, u.Email) {
		return errf(400, "The personal address must be different from the work email.")
	}
	if in.Send && in.PersonalEmail == "" {
		return errf(400, "Add a personal email address to send the setup email to.")
	}
	if in.Send && u.Email == "" {
		return errf(400, "This user has no work email address yet.")
	}
	if len(in.Note) > 2000 {
		return errf(400, "Keep the note under 2,000 characters.")
	}

	old := u.Attr("personalEmail")
	if old != in.PersonalEmail {
		var raw map[string]any
		if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/users/"+kc.P(u.ID), nil, &raw); err != nil {
			return err
		}
		attrs, _ := raw["attributes"].(map[string]any)
		if attrs == nil {
			attrs = map[string]any{}
		}
		if in.PersonalEmail == "" {
			delete(attrs, "personalEmail")
		} else {
			attrs["personalEmail"] = []string{in.PersonalEmail}
		}
		raw["attributes"] = attrs
		if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(u.ID), raw, nil); err != nil {
			return err
		}
		c.audit("user.personal_email", "user", u.ID, u.Username, "Set the personal email of "+u.Username,
			map[string]any{"changes": []string{"Personal email: " + orDash(old) + " → " + orDash(in.PersonalEmail)}})
		if sn, err = c.changed(); err != nil {
			return err
		}
		if u, err = c.user(sn, u.ID); err != nil {
			return err
		}
	}
	if in.Send {
		st := s.Settings()
		mb := st.Mailbox
		r := recipient{Email: in.PersonalEmail, Name: u.FullName(), First: u.FirstName, Username: u.Username, UserID: u.ID}
		c.notifyTo("mailbox.setup", []recipient{r}, func(recipient) tmail.Data {
			return tmail.Data{WorkEmail: u.Email, Mailbox: &mb, Note: in.Note}
		}, true)
		c.audit("user.mailbox_setup", "user", u.ID, u.Username, "Sent Outlook setup for "+u.Email+" to "+in.PersonalEmail, nil)
	}
	return c.JSON(200, toUser(sn, u))
}
