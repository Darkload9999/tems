// Package config loads the API's settings from the environment.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	PublicURL     string // e.g. https://tems.techzaz.lk (no trailing slash)
	DatabaseURL   string
	KCInternalURL string // http://keycloak:8080/auth
	KCRealm       string
	KCClientID    string // confidential service-account client (tems-api)
	KCSecret      string
	KCAdminClient string // public console client (tems-admin); tokens must be issued to it
	SMTPHost      string
	SMTPPort      string
	MailFrom      string
	MailFromName  string
	MailDomain    string
	DKIMSelector  string
	Listen        string
}

// Issuer is the token issuer as seen by browsers (Keycloak runs behind the gateway at /auth).
func (c Config) Issuer() string { return c.PublicURL + "/auth/realms/" + c.KCRealm }

// JWKSURL is reached over the internal network.
func (c Config) JWKSURL() string {
	return c.KCInternalURL + "/realms/" + c.KCRealm + "/protocol/openid-connect/certs"
}

func Load() (Config, error) {
	c := Config{
		PublicURL:     strings.TrimRight(env("PUBLIC_URL", ""), "/"),
		DatabaseURL:   env("DATABASE_URL", ""),
		KCInternalURL: strings.TrimRight(env("KC_INTERNAL_URL", "http://keycloak:8080/auth"), "/"),
		KCRealm:       env("KC_REALM", "tems"),
		KCClientID:    env("KC_API_CLIENT_ID", "tems-api"),
		KCSecret:      env("KC_API_CLIENT_SECRET", ""),
		KCAdminClient: env("KC_ADMIN_CLIENT_ID", "tems-admin"),
		SMTPHost:      env("SMTP_HOST", "mail"),
		SMTPPort:      env("SMTP_PORT", "587"),
		MailFrom:      env("MAIL_FROM", ""),
		MailFromName:  env("MAIL_FROM_NAME", "Techzaz EMS"),
		MailDomain:    env("MAIL_DOMAIN", ""),
		DKIMSelector:  env("DKIM_SELECTOR", "tems"),
		Listen:        env("LISTEN", ":8080"),
	}
	var missing []string
	for k, v := range map[string]string{"PUBLIC_URL": c.PublicURL, "DATABASE_URL": c.DatabaseURL, "KC_API_CLIENT_SECRET": c.KCSecret, "MAIL_FROM": c.MailFrom} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}
	if c.MailDomain == "" {
		if i := strings.LastIndex(c.MailFrom, "@"); i >= 0 {
			c.MailDomain = c.MailFrom[i+1:]
		}
	}
	return c, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
