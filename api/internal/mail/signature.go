package mail

import (
	"fmt"
	"strings"
)

// Signature is a team sign-off appended to emails (Settings → Email signatures).
type Signature struct {
	ID      string `json:"id"`
	Team    string `json:"team"`
	Company string `json:"company"`
	Email   string `json:"email"`
	Phone   string `json:"phone"`
	Web     string `json:"web"`
}

// DefaultSignatures are the seeded team templates.
var DefaultSignatures = []Signature{
	{ID: "hr", Team: "Human Resource Team", Company: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "techzaz.lk"},
	{ID: "it", Team: "IT Department", Company: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "techzaz.lk"},
	{ID: "marketing", Team: "Marketing Team", Company: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "techzaz.lk"},
}

// Categories group notification events for choosing which signature signs them.
var Categories = []string{"accounts", "people", "work"}

// Category returns the signature category of an event ("" for direct messages, which pick their own).
func Category(ev string) string {
	switch {
	case ev == "mail.direct":
		return ""
	case strings.HasPrefix(ev, "employee."), strings.HasPrefix(ev, "agreement."):
		return "people"
	case strings.HasPrefix(ev, "project."), strings.HasPrefix(ev, "ticket."):
		return "work"
	}
	return "accounts"
}

// Mailbox holds the work mailbox server settings sent in Outlook setup emails.
type Mailbox struct {
	IncomingHost     string `json:"incomingHost"`
	IncomingPort     int    `json:"incomingPort"`
	IncomingSecurity string `json:"incomingSecurity"`
	OutgoingHost     string `json:"outgoingHost"`
	OutgoingPort     int    `json:"outgoingPort"`
	OutgoingSecurity string `json:"outgoingSecurity"`
	Webmail          string `json:"webmail"`
}

var DefaultMailbox = Mailbox{
	IncomingHost: "mail.techzaz.lk", IncomingPort: 993, IncomingSecurity: "SSL/TLS",
	OutgoingHost: "mail.techzaz.lk", OutgoingPort: 587, OutgoingSecurity: "STARTTLS",
	Webmail: "https://mail.techzaz.lk",
}

func webHref(w string) string {
	if strings.HasPrefix(w, "http://") || strings.HasPrefix(w, "https://") {
		return w
	}
	return "https://" + w
}

func webLabel(w string) string {
	return strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(w, "https://"), "http://"), "/")
}

func telHref(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r == '+' || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return "tel:" + b.String()
}

// SignatureHTML renders a signature as an email-safe table (copper brand palette).
func SignatureHTML(s *Signature, origin string) string {
	if s == nil || s.Team == "" {
		return ""
	}
	row := func(label, value, href string) string {
		if value == "" {
			return ""
		}
		return fmt.Sprintf(`<tr><td style="padding:1px 10px 1px 0;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b98a63">%s</td><td style="padding:1px 0;font-size:13px"><a href="%s" style="color:#5b3d28;text-decoration:none">%s</a></td></tr>`, label, e(href), e(value))
	}
	var b strings.Builder
	b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;font-family:'Plus Jakarta Sans','Segoe UI',Arial,sans-serif"><tr>`)
	fmt.Fprintf(&b, `<td style="padding:0 18px 0 0;vertical-align:middle"><img src="%s/brand/logo-full.png" width="112" alt="Techzaz Networks" style="display:block;width:112px;height:auto"></td>`, e(origin))
	b.WriteString(`<td style="width:3px;background:#c99a72;background-image:linear-gradient(180deg,#e8c39f,#a86f45);border-radius:3px;font-size:0;line-height:0">&nbsp;</td>`)
	b.WriteString(`<td style="padding:2px 0 2px 16px;vertical-align:middle;line-height:1.5">`)
	fmt.Fprintf(&b, `<div style="font-size:15px;font-weight:700;color:#4a2f1d;letter-spacing:.005em">%s</div>`, e(s.Team))
	if s.Company != "" {
		fmt.Fprintf(&b, `<div style="font-size:13px;color:#8a6a52;margin-bottom:6px">%s</div>`, e(s.Company))
	}
	b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0">`)
	b.WriteString(row("Email", s.Email, "mailto:"+s.Email))
	b.WriteString(row("Mobile", s.Phone, telHref(s.Phone)))
	if s.Web != "" {
		b.WriteString(row("Web", webLabel(s.Web), webHref(s.Web)))
	}
	b.WriteString(`</table></td></tr></table>`)
	return b.String()
}

// SignatureText is the plain-text sign-off.
func SignatureText(s *Signature) []string {
	if s == nil || s.Team == "" {
		return nil
	}
	t := []string{"--", s.Team}
	if s.Company != "" {
		t = append(t, s.Company)
	}
	if s.Email != "" {
		t = append(t, "Email: "+s.Email)
	}
	if s.Phone != "" {
		t = append(t, "Mobile: "+s.Phone)
	}
	if s.Web != "" {
		t = append(t, "Web: "+webLabel(s.Web))
	}
	return t
}

// mailboxRows lists the Outlook account settings for a work address.
func mailboxRows(work string, m *Mailbox) [][2]string {
	return [][2]string{
		{"Email address", work},
		{"Account type", "IMAP"},
		{"Incoming server", fmt.Sprintf("%s · port %d · %s", m.IncomingHost, m.IncomingPort, m.IncomingSecurity)},
		{"Outgoing server (SMTP)", fmt.Sprintf("%s · port %d · %s", m.OutgoingHost, m.OutgoingPort, m.OutgoingSecurity)},
		{"User name", work},
		{"Password", "Your mailbox password (shared with you separately by IT)"},
		{"Outgoing authentication", "Required · same user name and password"},
	}
}

var outlookSteps = []string{
	"Open Outlook and go to <b>File → Add account</b> (on the new Outlook: <b>Settings → Accounts → Add account</b>).",
	"Enter your work email address, open <b>Advanced options</b>, tick <b>Let me set up my account manually</b> and select <b>Connect</b>.",
	"Choose <b>IMAP</b> and enter the incoming and outgoing server settings above.",
	"Enter your mailbox password, select <b>Connect</b>, then <b>Done</b>. Your inbox syncs in a minute or two.",
	"On your phone: install <b>Microsoft Outlook</b>, tap <b>Add account</b>, enter your work email, choose <b>IMAP</b> and use the same settings.",
}

func mailboxHTML(work string, m *Mailbox) string {
	var b strings.Builder
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1ecfd;border-radius:12px;margin:4px 0 18px"><tr><td style="padding:16px 18px">`)
	b.WriteString(`<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6d6884;margin-bottom:8px">Outlook account settings</div>`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">`)
	for _, r := range mailboxRows(work, m) {
		fmt.Fprintf(&b, `<tr><td style="padding:5px 12px 5px 0;font-size:13px;color:#6d6884;white-space:nowrap;vertical-align:top">%s</td><td style="padding:5px 0;font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:#2a1066">%s</td></tr>`, e(r[0]), e(r[1]))
	}
	b.WriteString(`</table></td></tr></table>`)
	b.WriteString(`<p style="margin:0 0 8px;font-weight:700">Set it up in Outlook</p><ol style="margin:0 0 16px;padding-left:20px">`)
	for _, s := range outlookSteps {
		fmt.Fprintf(&b, `<li style="margin:0 0 6px">%s</li>`, s)
	}
	b.WriteString(`</ol>`)
	if m.Webmail != "" {
		fmt.Fprintf(&b, `<p style="margin:0 0 14px">You can also read your mail in a browser at <a href="%s" style="color:#5b3fd6">%s</a>.</p>`, e(webHref(m.Webmail)), e(webLabel(m.Webmail)))
	}
	return b.String()
}

func mailboxText(work string, m *Mailbox) []string {
	t := []string{"", "Outlook account settings"}
	for _, r := range mailboxRows(work, m) {
		t = append(t, "  "+r[0]+": "+r[1])
	}
	t = append(t, "", "Set it up in Outlook")
	for i, s := range outlookSteps {
		t = append(t, fmt.Sprintf("  %d. %s", i+1, tags.ReplaceAllString(s, "")))
	}
	if m.Webmail != "" {
		t = append(t, "", "Webmail: "+webHref(m.Webmail))
	}
	return t
}
