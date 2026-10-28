package mail

import (
	"fmt"
	"strings"
)

// Signature is a person's or team's sign-off appended to emails (Settings → Email signatures).
type Signature struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Title string `json:"title"`
	Email string `json:"email"`
	Phone string `json:"phone"`
	Web   string `json:"web"`
}

// Footer follows every signature: the partner badges and the legal disclaimer.
type Footer struct {
	HideBadges bool   `json:"hideBadges"`
	Disclaimer string `json:"disclaimer"`
}

// DefaultSignatures are the seeded templates.
var DefaultSignatures = []Signature{
	{ID: "ceo", Name: "Saeed Ahamed", Title: "Chief executive officer", Email: "ceo@techzaz.lk", Phone: "+974 3994 9696", Web: "www.techzaz.lk"},
	{ID: "hr", Name: "Human Resource Team", Title: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "www.techzaz.lk"},
	{ID: "it", Name: "IT Department", Title: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "www.techzaz.lk"},
	{ID: "marketing", Name: "Marketing Team", Title: "Techzaz Networks (Pvt) Ltd", Email: "hr@techzaz.lk", Phone: "+76 766 2071", Web: "www.techzaz.lk"},
}

const DefaultDisclaimer = "Disclaimer: The contents of this email message and any attachments are intended solely for the addressee(s) and may contain confidential and/or privileged information and may be legally protected from disclosure. If you are not the intended recipient of this message or their agent, or if this message has been addressed to you in error, please immediately alert the sender by reply email and then delete this message and any attachments. If you are not the intended recipient, you are hereby notified that any use, relying on, taking action, publish, alter, dissemination, copying, or storage of this message or its attachments is strictly prohibited."

var DefaultFooter = Footer{Disclaimer: DefaultDisclaimer}

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

const stars = "**********************************************************************"

// SignatureHTML renders a signature as an email-safe table: logo, bronze rule,
// name, title and contact lines, then the partner badges and the disclaimer.
func SignatureHTML(s *Signature, f Footer, origin string) string {
	if s == nil || s.Name == "" {
		return ""
	}
	line := func(label, value, href string) string {
		if value == "" {
			return ""
		}
		return fmt.Sprintf(`<div>%s: <a href="%s" style="color:#7a5530;text-decoration:none">%s</a></div>`, label, e(href), e(value))
	}
	var b strings.Builder
	b.WriteString(`<div style="margin:26px 0 4px;font-family:'Plus Jakarta Sans','Segoe UI',Arial,sans-serif">`)
	b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0"><tr>`)
	fmt.Fprintf(&b, `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="%s/brand/logo-full.png" width="132" alt="Techzaz Networks" style="display:block;width:132px;height:auto"></td>`, e(origin))
	b.WriteString(`<td style="width:3px;background:#8b6a3e;font-size:0;line-height:0">&nbsp;</td>`)
	b.WriteString(`<td style="padding:2px 0 2px 12px;vertical-align:middle;font-size:13px;line-height:1.45;color:#7a5530">`)
	fmt.Fprintf(&b, `<div style="font-size:14px;font-weight:700;color:#5c3d1e">%s</div>`, e(s.Name))
	if s.Title != "" {
		fmt.Fprintf(&b, `<div>%s</div>`, e(s.Title))
	}
	b.WriteString(line("Email", s.Email, "mailto:"+s.Email))
	b.WriteString(line("Mobile", s.Phone, telHref(s.Phone)))
	if s.Web != "" {
		b.WriteString(line("Web", webLabel(s.Web), webHref(s.Web)))
	}
	b.WriteString(`</td></tr></table>`)
	if !f.HideBadges {
		fmt.Fprintf(&b, `<img src="%s/brand/partners.png" width="200" alt="AWS Partner · Google Cloud Partner" style="display:block;width:200px;height:auto;margin:18px 0 4px">`, e(origin))
	}
	if d := strings.TrimSpace(f.Disclaimer); d != "" {
		rule := `<div style="overflow:hidden;white-space:nowrap;font-size:11px;letter-spacing:1px;color:#9a95ad;line-height:1">` + stars + `</div>`
		fmt.Fprintf(&b, `<div style="margin-top:18px">%s<p style="margin:12px 0;font-size:11.5px;line-height:1.55;color:#6d6884">%s</p>%s</div>`, rule, strings.ReplaceAll(e(d), "\n", "<br>"), rule)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// SignatureText is the plain-text sign-off.
func SignatureText(s *Signature, f Footer) []string {
	if s == nil || s.Name == "" {
		return nil
	}
	t := []string{"--", s.Name}
	if s.Title != "" {
		t = append(t, s.Title)
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
	if !f.HideBadges {
		t = append(t, "AWS Partner · Google Cloud Partner")
	}
	if d := strings.TrimSpace(f.Disclaimer); d != "" {
		t = append(t, "", stars, "", d, "", stars)
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
