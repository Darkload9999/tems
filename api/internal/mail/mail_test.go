package mail

import (
	"bytes"
	"errors"
	"mime"
	"mime/multipart"
	netmail "net/mail"
	"net/textproto"
	"strings"
	"testing"

	"techzaz.lk/tems-api/internal/store"
)

func TestRenderEveryEvent(t *testing.T) {
	d := Data{Origin: "https://tems.example", FirstName: "Ann", Username: "ann", Actor: "Root", Group: "Staff",
		Added: []string{"users:view"}, Removed: []string{"mail:send"}, Changes: []string{"Phone: — → 123"},
		Subject: "Hello", Message: "Line one\n\nLine two"}
	for _, ev := range Events {
		subject, html, text := Render(ev, d)
		if subject == "" || html == "" || text == "" {
			t.Errorf("%s: empty output (subject=%q)", ev, subject)
		}
	}
}

func TestRenderEscapesHTML(t *testing.T) {
	_, html, _ := Render("user.created", Data{Username: `<script>x</script>`})
	if strings.Contains(html, "<script>") {
		t.Error("username was not escaped in HTML body")
	}
}

func TestBuildMessage(t *testing.T) {
	m := &Mailer{Domain: "tems.example"}
	raw, err := m.build(Identity{From: "no-reply@tems.example", FromName: "Techzaz EMS", ReplyTo: "help@tems.example"},
		store.MailItem{To: "ann@example.com", ToName: "Ann", Subject: "Prüfung ✓", Event: "mail.direct", HTML: "<p>hi</p>", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	msg, err := netmail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if subj, _ := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject")); subj != "Prüfung ✓" {
		t.Errorf("subject = %q", subj)
	}
	for k, want := range map[string]string{"Reply-To": "help@tems.example", "Auto-Submitted": "auto-generated", "X-TEMS-Event": "mail.direct"} {
		if got := msg.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if !strings.HasSuffix(msg.Header.Get("Message-ID"), "@tems.example>") {
		t.Errorf("Message-ID = %q", msg.Header.Get("Message-ID"))
	}
	_, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	mr := multipart.NewReader(msg.Body, params["boundary"])
	var types []string
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		types = append(types, strings.Split(p.Header.Get("Content-Type"), ";")[0])
	}
	if strings.Join(types, ",") != "text/plain,text/html" {
		t.Errorf("parts = %v", types)
	}
}

func TestBuildRejectsBadRecipient(t *testing.T) {
	_, err := (&Mailer{Domain: "x"}).build(Identity{From: "a@x"}, store.MailItem{To: "not an address"})
	var tp *textproto.Error
	if !errors.As(err, &tp) || tp.Code < 500 {
		t.Errorf("want permanent 5xx error, got %v", err)
	}
}

func TestSignatureAndMailboxSetup(t *testing.T) {
	sig := DefaultSignatures[0]
	_, html, text := Render("mailbox.setup", Data{Origin: "https://tems.example", FirstName: "Ann", Actor: "Root", WorkEmail: "ann@techzaz.lk", Signature: &sig})
	for _, want := range []string{"ann@techzaz.lk", "mail.techzaz.lk", "993", "STARTTLS", "Human Resource Team", "/brand/logo-full.png", `href="tel:+767662071"`, `href="https://techzaz.lk"`} {
		if !strings.Contains(html, want) {
			t.Errorf("html is missing %q", want)
		}
	}
	for _, want := range []string{"Incoming server: mail.techzaz.lk · port 993 · SSL/TLS", "--\nHuman Resource Team", "Web: techzaz.lk"} {
		if !strings.Contains(text, want) {
			t.Errorf("text is missing %q", want)
		}
	}
	if _, html, _ := Render("user.updated", Data{}); strings.Contains(html, "logo-full.png") {
		t.Error("signature rendered without one being set")
	}
}

func TestCategory(t *testing.T) {
	for ev, want := range map[string]string{"mail.direct": "", "employee.approved": "people", "agreement.sent": "people", "ticket.assigned": "work", "user.created": "accounts", "mailbox.setup": "accounts"} {
		if got := Category(ev); got != want {
			t.Errorf("Category(%q) = %q, want %q", ev, got, want)
		}
	}
}
