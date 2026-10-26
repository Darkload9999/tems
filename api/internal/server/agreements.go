package server

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"

	tmail "techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/store"
)

// How long a signing link stays valid after it is (re)sent.
const agreementTTL = 14 * 24 * time.Hour

type apiAgreement struct {
	ID         string     `json:"id"`
	EmployeeID string     `json:"employeeId"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"createdAt"`
	CreatedBy  string     `json:"createdBy"`
	SentAt     *time.Time `json:"sentAt"`
	ViewedAt   *time.Time `json:"viewedAt"`
	SignedAt   *time.Time `json:"signedAt"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	SignerName string     `json:"signerName"`
	SignerIP   string     `json:"signerIp"`
	Signature  *string    `json:"signature"`
	Link       string     `json:"link,omitempty"`
}

func sigURL(png []byte) *string {
	if len(png) == 0 {
		return nil
	}
	s := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	return &s
}

func toAgreement(a *store.Agreement) apiAgreement {
	return apiAgreement{
		ID: a.ID, EmployeeID: a.EmployeeID, Title: a.Title, Body: a.Body, Status: a.Status, CreatedAt: a.CreatedAt, CreatedBy: a.CreatedBy,
		SentAt: a.SentAt, ViewedAt: a.ViewedAt, SignedAt: a.SignedAt, ExpiresAt: a.ExpiresAt, SignerName: a.SignerName, SignerIP: a.SignerIP,
		Signature: sigURL(a.Signature),
	}
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func (c *call) agreement(e *store.Employee) (*store.Agreement, error) {
	a, err := c.s.st.GetAgreement(c.ctx(), e.ID, c.param("aid"))
	if errors.Is(err, store.ErrNotFound) {
		return nil, errf(404, "Agreement not found.")
	}
	return a, err
}

type agreementInput struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

func (in *agreementInput) clean() error {
	in.Title = clip(in.Title, 160)
	in.Body = strings.TrimSpace(strings.ReplaceAll(in.Body, "\r\n", "\n"))
	if in.Title == "" {
		return errf(400, "Give the agreement a title.")
	}
	if len(in.Body) < 20 || len(in.Body) > 100_000 {
		return errf(400, "The agreement text must be between 20 and 100,000 characters.")
	}
	return nil
}

func (s *Server) listAgreements(c *call) error {
	if err := c.need("employees:view"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	list, err := s.st.ListAgreements(c.ctx(), e.ID)
	if err != nil {
		return err
	}
	out := []apiAgreement{}
	for _, a := range list {
		out = append(out, toAgreement(a))
	}
	return c.JSON(200, out)
}

func (s *Server) createAgreement(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	var in agreementInput
	if err := c.decode(&in); err != nil {
		return err
	}
	if err := in.clean(); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	if e.Stage == "offboarded" {
		return errf(409, "This employee is offboarded.")
	}
	id, err := s.st.CreateAgreement(c.ctx(), e.ID, in.Title, in.Body, c.P.Name)
	if err != nil {
		return err
	}
	a, err := s.st.GetAgreement(c.ctx(), e.ID, id)
	if err != nil {
		return err
	}
	c.event(e, "agreement.create", "Drafted “"+a.Title+"”", "")
	c.audit("agreement.create", "employee", e.ID, e.Name(), "Drafted agreement “"+a.Title+"” for "+e.Name(), nil)
	return c.JSON(201, toAgreement(a))
}

func (s *Server) updateAgreement(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	var in agreementInput
	if err := c.decode(&in); err != nil {
		return err
	}
	if err := in.clean(); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	a, err := c.agreement(e)
	if err != nil {
		return err
	}
	if a.Status != "draft" {
		return errf(409, "Only drafts can be edited. Void this agreement and draft a new one instead.")
	}
	if err := s.st.UpdateAgreementDraft(c.ctx(), a.ID, in.Title, in.Body); err != nil {
		return err
	}
	a, _ = s.st.GetAgreement(c.ctx(), e.ID, a.ID)
	return c.JSON(200, toAgreement(a))
}

func (s *Server) sendAgreement(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	a, err := c.agreement(e)
	if err != nil {
		return err
	}
	if e.Stage != "agreement" && e.Stage != "active" {
		return errf(409, "Agreements can be sent once the onboarding is approved.")
	}
	if a.Status != "draft" && a.Status != "sent" && a.Status != "viewed" {
		return errf(409, "This agreement is %s and can no longer be sent.", a.Status)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(a.Title + "\n\n" + a.Body))
	expires := time.Now().Add(agreementTTL).UTC()
	if err := s.st.SendAgreement(c.ctx(), a.ID, hashToken(token), hex.EncodeToString(sum[:]), c.P.ID, expires); err != nil {
		return err
	}
	link := s.cfg.PublicURL + "/sign/?t=" + url.QueryEscape(token)
	verb := "Sent"
	if a.Status != "draft" {
		verb = "Re-sent (previous link revoked)"
	}
	a, _ = s.st.GetAgreement(c.ctx(), e.ID, a.ID)
	c.event(e, "agreement.send", verb+" “"+a.Title+"” for signature", "")
	c.audit("agreement.send", "employee", e.ID, e.Name(), verb+" agreement “"+a.Title+"” to "+e.Email, map[string]any{"expires": expires})
	c.notifyTo("agreement.sent", []recipient{empRcpt(e)}, func(recipient) tmail.Data {
		return tmail.Data{Item: a.Title, Link: link, Expires: expires.Format("02 Jan 2006")}
	}, true)
	out := toAgreement(a)
	out.Link = link
	return c.JSON(200, out)
}

func (s *Server) voidAgreement(c *call) error {
	if err := c.need("employees:manage"); err != nil {
		return err
	}
	e, err := c.employee()
	if err != nil {
		return err
	}
	a, err := c.agreement(e)
	if err != nil {
		return err
	}
	if a.Status == "signed" || a.Status == "void" {
		return errf(409, "This agreement is already %s.", a.Status)
	}
	if err := s.st.VoidAgreement(c.ctx(), a.ID); err != nil {
		return err
	}
	a, _ = s.st.GetAgreement(c.ctx(), e.ID, a.ID)
	c.event(e, "agreement.void", "Voided “"+a.Title+"” (signing link revoked)", "")
	c.audit("agreement.void", "employee", e.ID, e.Name(), "Voided agreement “"+a.Title+"”", nil)
	return c.JSON(200, toAgreement(a))
}

/* ---------- public signing (token-authenticated) ---------- */

type publicAgreement struct {
	Title        string     `json:"title"`
	Body         string     `json:"body"`
	OrgName      string     `json:"orgName"`
	EmployeeName string     `json:"employeeName"`
	Status       string     `json:"status"`
	ExpiresAt    *time.Time `json:"expiresAt"`
	SignedAt     *time.Time `json:"signedAt"`
	SignerName   string     `json:"signerName"`
	Signature    *string    `json:"signature"`
}

// byToken resolves a signing link. Unknown, revoked and expired links all fail.
func (c *call) byToken() (*store.Agreement, *store.Employee, error) {
	t := c.param("token")
	if len(t) < 32 || len(t) > 64 {
		return nil, nil, errf(404, "This signing link is not valid. Ask HR to send you a new one.")
	}
	a, err := c.s.st.AgreementByToken(c.ctx(), hashToken(t))
	if errors.Is(err, store.ErrNotFound) || (err == nil && a.Status == "void") {
		return nil, nil, errf(404, "This signing link is not valid. Ask HR to send you a new one.")
	}
	if err != nil {
		return nil, nil, err
	}
	if a.ExpiresAt != nil && time.Now().After(*a.ExpiresAt) {
		return nil, nil, errf(410, "This signing link has expired. Ask HR to send you a new one.")
	}
	e, err := c.s.st.GetEmployee(c.ctx(), a.EmployeeID)
	if err != nil {
		return nil, nil, err
	}
	return a, e, nil
}

func (s *Server) toPublic(a *store.Agreement, e *store.Employee) publicAgreement {
	return publicAgreement{Title: a.Title, Body: a.Body, OrgName: s.Settings().OrgName, EmployeeName: e.Name(), Status: a.Status,
		ExpiresAt: a.ExpiresAt, SignedAt: a.SignedAt, SignerName: a.SignerName, Signature: sigURL(a.Signature)}
}

func (s *Server) publicAgreement(c *call) error {
	a, e, err := c.byToken()
	if err != nil {
		return err
	}
	if a.Status == "sent" {
		c.as = e.Name()
		_ = s.st.MarkAgreementViewed(c.ctx(), a.ID)
		c.event(e, "agreement.view", "Opened “"+a.Title+"”", "")
		a.Status = "viewed"
	}
	return c.JSON(200, s.toPublic(a, e))
}

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

func (s *Server) signAgreement(c *call) error {
	var in struct {
		Name      string `json:"name"`
		Signature string `json:"signature"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	a, e, err := c.byToken()
	if err != nil {
		return err
	}
	if a.Status == "signed" {
		return errf(409, "This agreement is already signed.")
	}
	in.Name = clip(in.Name, 120)
	if len([]rune(in.Name)) < 3 {
		return errf(400, "Type your full name.")
	}
	b64, ok := strings.CutPrefix(in.Signature, "data:image/png;base64,")
	png, derr := base64.StdEncoding.DecodeString(b64)
	if !ok || derr != nil || len(png) < 100 || len(png) > 512<<10 || !bytes.HasPrefix(png, pngMagic) {
		return errf(400, "Draw your signature in the box.")
	}
	c.as = in.Name
	signed, err := s.st.SignAgreement(c.ctx(), a.ID, in.Name, clientIP(c.R), clip(c.R.UserAgent(), 300), png)
	if err != nil {
		return err
	}
	if !signed {
		return errf(409, "This agreement can no longer be signed. Ask HR to send you a new link.")
	}
	a, _ = s.st.GetAgreement(c.ctx(), e.ID, a.ID)

	// Keep a self-contained signed copy in the employee file.
	copyHTML := signedCopy(s.Settings().OrgName, e, a)
	sum := sha256.Sum256(copyHTML)
	_ = s.st.AddDocument(c.ctx(), &store.Document{
		EmployeeID: e.ID, Category: "agreement", Title: "Signed: " + a.Title, Filename: safeFilename("Signed - " + a.Title + ".html"),
		ContentType: "text/html; charset=utf-8", Size: len(copyHTML), SHA256: hex.EncodeToString(sum[:]), Data: copyHTML, UploadedBy: in.Name,
	})
	c.event(e, "agreement.sign", "Signed “"+a.Title+"” as "+in.Name, "")
	c.audit("agreement.sign", "employee", e.ID, e.Name(), e.Name()+" signed agreement “"+a.Title+"”", map[string]any{"ip": a.SignerIP, "bodySha256": a.BodySHA256})
	if e.Stage == "agreement" {
		if err := s.st.SetStage(c.ctx(), e.ID, "active", nil, nil, nil); err == nil {
			c.event(e, "employee.active", "Onboarding complete", "")
		}
	}

	link := s.cfg.PublicURL + "/sign/?t=" + url.QueryEscape(c.param("token"))
	c.notifyTo("agreement.signed", []recipient{empRcpt(e)}, func(recipient) tmail.Data { return tmail.Data{Item: a.Title, Link: link} }, false)
	if a.SentByID != nil {
		if sn, err := c.snap(); err == nil {
			if u := sn.ByID[*a.SentByID]; u != nil {
				c.notifyTo("agreement.signed", []recipient{userRcpt(u)}, func(recipient) tmail.Data {
					return tmail.Data{Item: a.Title, Person: e.Name(), Link: s.employeeLink(e.ID)}
				}, false)
			}
		}
	}
	return c.JSON(200, s.toPublic(a, e))
}

// signedCopy renders the signed agreement as a standalone, printable HTML page.
func signedCopy(org string, e *store.Employee, a *store.Agreement) []byte {
	esc := html.EscapeString
	var paras strings.Builder
	for _, p := range strings.Split(a.Body, "\n\n") {
		fmt.Fprintf(&paras, "<p>%s</p>\n", strings.ReplaceAll(esc(strings.TrimSpace(p)), "\n", "<br>"))
	}
	when := func(t *time.Time) string {
		if t == nil {
			return "—"
		}
		return t.UTC().Format("02 Jan 2006, 15:04 UTC")
	}
	sig := ""
	if s := sigURL(a.Signature); s != nil {
		sig = `<img src="` + *s + `" alt="Signature" style="max-width:320px;height:auto;display:block">`
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>%s — signed</title>
<style>body{font:15px/1.65 Georgia,'Times New Roman',serif;color:#1c1b20;max-width:760px;margin:40px auto;padding:0 24px}
h1{font:700 26px/1.2 Arial,sans-serif;margin:0 0 4px}.org{font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#6229c9}
.sig{margin-top:36px;padding-top:18px;border-top:2px solid #1c1b20}.meta{font:12px/1.6 Arial,sans-serif;color:#555;margin-top:22px;border:1px solid #ddd;border-radius:8px;padding:12px 14px}
.meta b{color:#1c1b20}@media print{body{margin:0}}</style></head><body>
<div class="org">%s</div><h1>%s</h1><p style="font:13px Arial,sans-serif;color:#555;margin:0 0 24px">Between %s and %s (%s)</p>
%s
<div class="sig">%s<div><b>%s</b></div><div style="font:13px Arial,sans-serif;color:#555">Signed electronically on %s</div></div>
<div class="meta"><b>Signature record</b><br>Signer: %s · Email on file: %s<br>Signed: %s · IP address: %s<br>Link sent: %s · First opened: %s<br>Document SHA-256: <code>%s</code></div>
</body></html>`,
		esc(a.Title), esc(org), esc(a.Title), esc(org), esc(e.Name()), esc(e.Code), paras.String(), sig, esc(a.SignerName), when(a.SignedAt),
		esc(a.SignerName), esc(e.Email), when(a.SignedAt), esc(a.SignerIP), when(a.SentAt), when(a.ViewedAt), esc(a.BodySHA256))
	return b.Bytes()
}
