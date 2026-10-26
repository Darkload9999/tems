// Package mail renders TEMS notification emails and delivers the outbox via SMTP.
// The design matches the console's preview renderer (web/src/lib/email.ts).
package mail

import (
	"fmt"
	"html"
	"regexp"
	"strings"
	"time"
)

// Events lists every notification event; settings toggle all but mail.direct.
var Events = []string{
	"user.created", "user.updated", "user.disabled", "user.enabled", "user.deleted",
	"user.password_reset", "user.sessions_revoked", "superadmin.granted", "superadmin.revoked",
	"group.member_added", "group.member_removed", "group.permissions_changed", "group.renamed", "group.deleted",
	"member.permissions_changed", "mail.direct",
}

type Data struct {
	Origin    string
	FirstName string
	Username  string
	Actor     string
	Group     string
	NewName   string
	Added     []string
	Removed   []string
	Changes   []string
	Setup     string // "link" | "temporary"
	Subject   string
	Message   string
}

type copyText struct {
	subject, title, lead, body, cta, tone string
}

var e = html.EscapeString

func copyFor(ev string, d Data) copyText {
	g := d.Group
	if g == "" {
		g = "a group"
	}
	switch ev {
	case "user.created":
		body := "You will receive a separate email with a secure link to set your password. The link expires in 12 hours."
		if d.Setup == "temporary" {
			body = "Your administrator will share a temporary password with you. You will be asked to choose your own password the first time you sign in."
		}
		return copyText{"Welcome to Techzaz EMS", "Welcome aboard.", "An administrator created your Techzaz EMS account. Your username is <b>" + e(d.Username) + "</b>.", body, "Sign in to Techzaz EMS", "ok"}
	case "user.updated":
		return copyText{"Your account details were updated", "Profile updated.", "An administrator updated the following details on your account:", "", "", ""}
	case "user.disabled":
		return copyText{"Your account has been disabled", "Access paused.", "Your Techzaz EMS account has been disabled and you can no longer sign in. If you believe this is a mistake, contact your administrator.", "", "", "warn"}
	case "user.enabled":
		return copyText{"Your account has been re-enabled", "Welcome back.", "Your Techzaz EMS account is active again. You can sign in as usual.", "", "Sign in", "ok"}
	case "user.deleted":
		return copyText{"Your account has been removed", "Account removed.", "Your Techzaz EMS account has been permanently removed by an administrator. You will no longer be able to sign in.", "", "", "warn"}
	case "user.password_reset":
		lead := "An administrator reset your password. You will receive a separate email with a secure link to choose a new one."
		if d.Setup == "temporary" {
			lead = "An administrator reset your password. They will share a temporary password with you, and you will choose a new one on your next sign-in."
		}
		return copyText{"Your password was reset", "Password reset.", lead, "", "", "warn"}
	case "user.sessions_revoked":
		return copyText{"You were signed out of all devices", "Signed out.", "An administrator ended all of your active sessions. Sign in again to continue.", "", "Sign in", "warn"}
	case "superadmin.granted":
		return copyText{"You are now a super administrator", "Full access.", "You were granted <b>super administrator</b> rights. You now have unrestricted access to every part of Techzaz EMS. Please use it carefully.", "", "", "ok"}
	case "superadmin.revoked":
		return copyText{"Your super administrator rights were removed", "Access changed.", "Your super administrator rights were removed. Your access now follows your group and personal permissions.", "", "", "warn"}
	case "group.member_added":
		return copyText{"You were added to " + g, "New group.", "You are now a member of <b>" + e(g) + "</b>.", "", "", "ok"}
	case "group.member_removed":
		return copyText{"You were removed from " + g, "Group left.", "You are no longer a member of <b>" + e(g) + "</b>.", "", "", ""}
	case "group.permissions_changed":
		return copyText{"Permissions for " + g + " changed", "Access updated.", "The permissions granted by <b>" + e(g) + "</b>, a group you belong to, have changed:", "", "", ""}
	case "group.renamed":
		return copyText{g + " is now " + d.NewName, "Group renamed.", "The group <b>" + e(g) + "</b> has been renamed to <b>" + e(d.NewName) + "</b>. Your access is unchanged.", "", "", ""}
	case "group.deleted":
		return copyText{g + " was deleted", "Group deleted.", "The group <b>" + e(g) + "</b> was deleted. Any permissions it granted you have been removed.", "", "", "warn"}
	case "member.permissions_changed":
		return copyText{"Your permissions changed", "Access updated.", "An administrator changed your personal permissions:", "", "", ""}
	case "mail.direct":
		s := d.Subject
		if s == "" {
			s = "Message from Techzaz EMS"
		}
		return copyText{s, "Message.", "", "", "", ""}
	}
	return copyText{"Notification from Techzaz EMS", "Notice.", "", "", "", ""}
}

func rows(items []string, color, sign string) string {
	var b strings.Builder
	for _, x := range items {
		fmt.Fprintf(&b, `<tr><td style="padding:3px 0;font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:%s">%s %s</td></tr>`, color, sign, e(x))
	}
	return b.String()
}

var tags = regexp.MustCompile(`<[^>]+>`)
var paraSplit = regexp.MustCompile(`\n{2,}`)

// Render returns subject, HTML and plain-text bodies for an event.
func Render(ev string, d Data) (subject, htmlBody, text string) {
	c := copyFor(ev, d)
	accent := "#7b46e3"
	switch c.tone {
	case "warn":
		accent = "#b7791f"
	case "ok":
		accent = "#0f9f6e"
	}
	list := rows(d.Added, "#0f9f6e", "+") + rows(d.Removed, "#d12b55", "−") + rows(d.Changes, "#2a1066", "•")
	var msg strings.Builder
	if ev == "mail.direct" {
		for _, p := range paraSplit.Split(d.Message, -1) {
			fmt.Fprintf(&msg, `<p style="margin:0 0 14px">%s</p>`, strings.ReplaceAll(e(p), "\n", "<br>"))
		}
	}
	verb := "Changed"
	if ev == "mail.direct" {
		verb = "Sent"
	}
	when := time.Now().Format("02 Jan 2006, 15:04")
	greet := d.FirstName
	if greet == "" {
		greet = d.Username
	}
	if greet == "" {
		greet = "there"
	}

	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + e(c.subject) + `</title>`)
	b.WriteString(`<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;700&family=Plus+Jakarta+Sans:wght@400;700&display=swap" rel="stylesheet"></head>`)
	b.WriteString(`<body style="margin:0;padding:0;background:#efeaf9;font-family:'Plus Jakarta Sans','Segoe UI',Arial,sans-serif;color:#1c1b20">`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efeaf9;padding:32px 12px"><tr><td align="center">`)
	b.WriteString(`<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(34,9,77,.45)">`)
	b.WriteString(`<tr><td style="background:#2d0d60;background-image:radial-gradient(60% 80% at 25% 10%,rgba(140,92,240,.55),transparent 70%),repeating-linear-gradient(90deg,rgba(255,255,255,.06) 0 1px,transparent 1px 37px),repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 12px,transparent 12px 97px);padding:24px 30px 30px">`)
	fmt.Fprintf(&b, `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td><img src="%s/brand/logo-mark.png" width="34" alt="Techzaz" style="display:block"></td>`, e(d.Origin))
	b.WriteString(`<td style="padding-left:10px;font-family:Montserrat,Arial,sans-serif;font-size:19px;letter-spacing:.01em"><span style="font-weight:300;color:#e9e2ff">TECHZAZ</span><span style="color:#e9e2ff">+</span><b style="color:#ffffff">EMS</b></td></tr></table>`)
	fmt.Fprintf(&b, `<div style="margin-top:44px;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:40px;line-height:1;color:#ffffff;text-align:right;text-transform:uppercase;letter-spacing:-.01em">%s</div></td></tr>`, e(c.title))
	fmt.Fprintf(&b, `<tr><td style="height:4px;background:%s"></td></tr>`, accent)
	b.WriteString(`<tr><td style="padding:30px 30px 8px;font-size:15px;line-height:1.65">`)
	fmt.Fprintf(&b, `<p style="margin:0 0 14px">Hi %s,</p>`, e(greet))
	if c.lead != "" {
		fmt.Fprintf(&b, `<p style="margin:0 0 14px">%s</p>`, c.lead)
	}
	b.WriteString(msg.String())
	if list != "" {
		fmt.Fprintf(&b, `<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:#f1ecfd;border-radius:12px;margin:4px 0 18px"><tr><td style="padding:14px 18px"><table role="presentation" cellpadding="0" cellspacing="0">%s</table></td></tr></table>`, list)
	}
	if c.body != "" {
		fmt.Fprintf(&b, `<p style="margin:0 0 14px">%s</p>`, e(c.body))
	}
	if c.cta != "" {
		fmt.Fprintf(&b, `<p style="margin:22px 0 22px"><a href="%s" style="display:inline-block;background:#22094d;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px">%s &rarr;</a></p>`, e(d.Origin), e(c.cta))
	}
	fmt.Fprintf(&b, `<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #ece7f6;font-size:12.5px;color:#6d6884">%s by %s · %s.<br>If you did not expect this email, contact <a href="mailto:soc@techzaz.lk" style="color:#5b3fd6">soc@techzaz.lk</a>.</p>`, verb, e(d.Actor), e(when))
	b.WriteString(`</td></tr><tr><td style="padding:16px 30px 22px;font-size:11.5px;color:#9a95ad;line-height:1.6">Techzaz Networks · 476/2 Sri Rajasinghe Mawatha, Wattala 11104, Sri Lanka<br>This is an automated message from Techzaz EMS. Please do not reply.</td></tr>`)
	b.WriteString(`</table></td></tr></table></body></html>`)

	// plain-text alternative
	var t []string
	t = append(t, "Hi "+greet+",", "")
	if c.lead != "" {
		t = append(t, html.UnescapeString(tags.ReplaceAllString(c.lead, "")))
	}
	if ev == "mail.direct" {
		t = append(t, d.Message)
	}
	for _, x := range d.Added {
		t = append(t, "+ "+x)
	}
	for _, x := range d.Removed {
		t = append(t, "- "+x)
	}
	for _, x := range d.Changes {
		t = append(t, "* "+x)
	}
	if c.body != "" {
		t = append(t, "", c.body)
	}
	if c.cta != "" {
		t = append(t, "", c.cta+": "+d.Origin)
	}
	t = append(t, "", verb+" by "+d.Actor+" · "+when+".", "Techzaz Networks — automated message from Techzaz EMS.")
	return c.subject, b.String(), strings.Join(t, "\n")
}
