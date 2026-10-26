package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	netmail "net/mail"
	"net/smtp"
	"net/textproto"
	"strings"
	"time"

	"techzaz.lk/tems-api/internal/store"
)

// Sender identity, read from settings at send time.
type Identity struct{ From, FromName, ReplyTo string }

type Mailer struct {
	Host, Port   string
	Domain       string // sending domain (DKIM is applied by Postfix/OpenDKIM)
	DKIMSelector string
	Store        *store.Store
	Identity     func(ctx context.Context) Identity

	kick chan struct{}
}

const maxAttempts = 6

// New prepares a mailer; call Run in a goroutine.
func New(m Mailer) *Mailer {
	m.kick = make(chan struct{}, 1)
	return &m
}

func (m *Mailer) addr() string { return net.JoinHostPort(m.Host, m.Port) }

// Kick wakes the worker so freshly queued mail goes out immediately.
func (m *Mailer) Kick() {
	select {
	case m.kick <- struct{}{}:
	default:
	}
}

// Run delivers the outbox until ctx is cancelled.
func (m *Mailer) Run(ctx context.Context) {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		m.drain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-m.kick:
		}
	}
}

func (m *Mailer) drain(ctx context.Context) {
	for {
		due, err := m.Store.Due(ctx, 25)
		if err != nil {
			slog.Error("outbox: load due mail", "err", err)
			return
		}
		if len(due) == 0 {
			return
		}
		id := m.Identity(ctx)
		for _, item := range due {
			err := m.send(id, item)
			if err == nil {
				_ = m.Store.MarkSent(ctx, item.ID)
				slog.Info("mail sent", "to", item.To, "event", item.Event)
				continue
			}
			limit := maxAttempts
			var tp *textproto.Error
			if errors.As(err, &tp) && tp.Code >= 500 {
				limit = 0 // permanent rejection: don't retry
			}
			backoff := time.Duration(30<<min(item.Attempts, 7)) * time.Second
			_ = m.Store.MarkAttemptFailed(ctx, item.ID, err.Error(), limit, backoff)
			slog.Warn("mail attempt failed", "to", item.To, "attempt", item.Attempts+1, "err", err)
		}
		if len(due) < 25 {
			return
		}
	}
}

func (m *Mailer) send(id Identity, item store.MailItem) error {
	msg, err := m.build(id, item)
	if err != nil {
		return err
	}
	conn, err := net.DialTimeout("tcp", m.addr(), 10*time.Second)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, m.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	// Internal hop on the private Docker network: no STARTTLS here; Postfix uses
	// opportunistic TLS towards the recipient's mail server.
	if err := c.Hello("tems-api." + m.Domain); err != nil {
		return err
	}
	if err := c.Mail(id.From); err != nil {
		return err
	}
	if err := c.Rcpt(item.To); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func (m *Mailer) build(id Identity, item store.MailItem) ([]byte, error) {
	from := (&netmail.Address{Name: id.FromName, Address: id.From}).String()
	to := (&netmail.Address{Name: item.ToName, Address: item.To}).String()
	if _, err := netmail.ParseAddress(item.To); err != nil {
		return nil, &textproto.Error{Code: 553, Msg: "invalid recipient address"}
	}
	boundary := "tems-" + randHex(12)
	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", from)
	h("To", to)
	if id.ReplyTo != "" {
		h("Reply-To", id.ReplyTo)
	}
	h("Subject", encodeHeader(item.Subject))
	h("Date", time.Now().Format(time.RFC1123Z))
	h("Message-ID", "<"+randHex(16)+"@"+m.Domain+">")
	h("MIME-Version", "1.0")
	h("Auto-Submitted", "auto-generated")
	h("X-Auto-Response-Suppress", "All")
	h("X-TEMS-Event", item.Event)
	h("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	part := func(ctype, body string) {
		fmt.Fprintf(&b, "--%s\r\nContent-Type: %s; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n", boundary, ctype)
		enc := base64.StdEncoding.EncodeToString([]byte(body))
		for len(enc) > 76 {
			b.WriteString(enc[:76] + "\r\n")
			enc = enc[76:]
		}
		b.WriteString(enc + "\r\n")
	}
	part("text/plain", item.Text)
	part("text/html", item.HTML)
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes(), nil
}

func encodeHeader(s string) string {
	for _, r := range s {
		if r > 127 {
			return "=?utf-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
		}
	}
	return s
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Health checks the SMTP hop and whether the DKIM DNS record is published.
type Health struct {
	OK     bool   `json:"ok"`
	Host   string `json:"host"`
	Detail string `json:"detail"`
	DKIM   bool   `json:"dkim"`
	Queue  int    `json:"queue"`
}

func (m *Mailer) Health(ctx context.Context) Health {
	h := Health{Host: m.addr() + " · Postfix + OpenDKIM"}
	conn, err := net.DialTimeout("tcp", m.addr(), 3*time.Second)
	if err != nil {
		h.Detail = "SMTP unreachable: " + err.Error()
	} else {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		if c, err := smtp.NewClient(conn, m.Host); err != nil {
			h.Detail = "SMTP handshake failed: " + err.Error()
			conn.Close()
		} else {
			h.OK = true
			_ = c.Quit()
		}
	}
	rec := m.DKIMSelector + "._domainkey." + m.Domain
	lctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if txts, err := net.DefaultResolver.LookupTXT(lctx, rec); err == nil {
		h.DKIM = strings.Contains(strings.Join(txts, ""), "p=")
	}
	if h.OK {
		if h.DKIM {
			h.Detail = "Accepting mail · DKIM record published at " + rec
		} else {
			h.Detail = "Accepting mail · DKIM record not found at " + rec + " (publish it for inbox delivery)"
		}
	}
	return h
}
