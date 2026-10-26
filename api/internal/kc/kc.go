// Package kc is a small Keycloak Admin REST client authenticated with the
// tems-api service account (client credentials).
package kc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	base, realm, clientID, secret string
	hc                            *http.Client

	mu  sync.Mutex
	tok string
	exp time.Time
}

func New(base, realm, clientID, secret string) *Client {
	return &Client{base: base, realm: realm, clientID: clientID, secret: secret, hc: &http.Client{Timeout: 20 * time.Second}}
}

// Error is a non-2xx answer from Keycloak.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return fmt.Sprintf("keycloak %d: %s", e.Status, e.Msg) }

func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

func (c *Client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tok != "" && time.Now().Before(c.exp) {
		return c.tok, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.clientID}, "client_secret": {c.secret}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/realms/"+c.realm+"/protocol/openid-connect/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&t); err != nil || res.StatusCode != 200 {
		return "", &Error{res.StatusCode, "service account token: " + t.Error}
	}
	c.tok, c.exp = t.AccessToken, time.Now().Add(time.Duration(t.ExpiresIn-30)*time.Second)
	return c.tok, nil
}

// Do calls /admin/realms/{realm}{path}. body and out may be nil. Returns response headers.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) (http.Header, error) {
	tok, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, c.base+"/admin/realms/"+c.realm+path, rd)
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if res.StatusCode >= 300 {
		return res.Header, &Error{res.StatusCode, errMessage(raw)}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return res.Header, fmt.Errorf("decode %s %s: %w", method, path, err)
		}
	}
	return res.Header, nil
}

// errMessage turns Keycloak's various error shapes into a readable sentence.
func errMessage(raw []byte) string {
	var e struct {
		ErrorMessage string `json:"errorMessage"`
		Error        string `json:"error"`
		Description  string `json:"error_description"`
	}
	_ = json.Unmarshal(raw, &e)
	msg := e.ErrorMessage
	if msg == "" {
		msg = e.Description
	}
	if msg == "" {
		msg = e.Error
	}
	if msg == "" {
		msg = strings.TrimSpace(string(raw))
	}
	return friendly(msg)
}

var friendlyMsgs = map[string]string{
	"invalidPasswordMinLengthMessage":         "The password is too short.",
	"invalidPasswordMinDigitsMessage":         "The password needs at least one digit.",
	"invalidPasswordMinUpperCaseCharsMessage": "The password needs at least one upper-case letter.",
	"invalidPasswordMinLowerCaseCharsMessage": "The password needs at least one lower-case letter.",
	"invalidPasswordNotUsernameMessage":       "The password must not be the username.",
	"invalidPasswordHistoryMessage":           "The password was used recently.",
}

func friendly(m string) string {
	for k, v := range friendlyMsgs {
		if strings.Contains(m, k) {
			return v
		}
	}
	return m
}

// IDFromLocation extracts the created resource id from a Location header.
func IDFromLocation(h http.Header) string {
	loc := h.Get("Location")
	return loc[strings.LastIndex(loc, "/")+1:]
}

/* ---------- representations ---------- */

type User struct {
	ID               string              `json:"id"`
	Username         string              `json:"username"`
	Email            string              `json:"email"`
	FirstName        string              `json:"firstName"`
	LastName         string              `json:"lastName"`
	Enabled          bool                `json:"enabled"`
	EmailVerified    bool                `json:"emailVerified"`
	CreatedTimestamp int64               `json:"createdTimestamp"`
	Attributes       map[string][]string `json:"attributes"`
	RequiredActions  []string            `json:"requiredActions"`
	ServiceAccount   string              `json:"serviceAccountClientId,omitempty"`
}

func (u *User) Attr(k string) string {
	if v := u.Attributes[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

func (u *User) FullName() string {
	n := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if n == "" {
		return u.Username
	}
	return n
}

type Role struct {
	ID          string              `json:"id,omitempty"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	ClientRole  bool                `json:"clientRole,omitempty"`
	ContainerID string              `json:"containerId,omitempty"`
	Attributes  map[string][]string `json:"attributes,omitempty"`
}

func (r Role) Attr(k string) string {
	if v := r.Attributes[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

type Group struct {
	ID         string              `json:"id,omitempty"`
	Name       string              `json:"name"`
	Path       string              `json:"path,omitempty"`
	Attributes map[string][]string `json:"attributes,omitempty"`
}

func (g Group) Attr(k string) string {
	if v := g.Attributes[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

type Session struct {
	ID         string            `json:"id"`
	UserID     string            `json:"userId"`
	IPAddress  string            `json:"ipAddress"`
	Start      int64             `json:"start"`
	LastAccess int64             `json:"lastAccess"`
	Clients    map[string]string `json:"clients"`
}

type Event struct {
	Time      int64  `json:"time"`
	Type      string `json:"type"`
	UserID    string `json:"userId"`
	IPAddress string `json:"ipAddress"`
}

/* ---------- helpers for common calls ---------- */

func P(s string) string { return url.PathEscape(s) }

func (c *Client) ClientUUID(ctx context.Context, clientID string) (string, error) {
	var cs []struct {
		ID string `json:"id"`
	}
	if _, err := c.Do(ctx, http.MethodGet, "/clients?clientId="+url.QueryEscape(clientID), nil, &cs); err != nil {
		return "", err
	}
	if len(cs) == 0 {
		return "", fmt.Errorf("client %q not found in realm", clientID)
	}
	return cs[0].ID, nil
}
