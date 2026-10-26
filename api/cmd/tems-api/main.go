// tems-api: the Techzaz EMS backend.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"techzaz.lk/tems-api/internal/config"
	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	"techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/server"
	"techzaz.lk/tems-api/internal/store"
)

func main() {
	health := flag.Bool("healthcheck", false, "probe the local API and exit (for Docker)")
	flag.Parse()
	if *health {
		c := http.Client{Timeout: 3 * time.Second}
		res, err := c.Get("http://127.0.0.1:8080/api/healthz")
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := retry(ctx, "database", func() error { return st.Migrate(ctx) }); err != nil {
		return err
	}

	k := kc.New(cfg.KCInternalURL, cfg.KCRealm, cfg.KCClientID, cfg.KCSecret)
	var clientUUID string
	if err := retry(ctx, "keycloak", func() (err error) { clientUUID, err = k.ClientUUID(ctx, cfg.KCClientID); return }); err != nil {
		return err
	}
	if err := bootstrapRealm(ctx, k); err != nil {
		slog.Warn("realm bootstrap", "err", err)
	}
	if err := server.EnsureCatalog(ctx, k, clientUUID); err != nil {
		slog.Warn("permission catalog", "err", err)
	}

	d := dir.New(k, st, clientUUID)
	var srv *server.Server
	m := mail.New(mail.Mailer{
		Host: cfg.SMTPHost, Port: cfg.SMTPPort, Domain: cfg.MailDomain, DKIMSelector: cfg.DKIMSelector, Store: st,
		Identity: func(c context.Context) mail.Identity { return srv.MailIdentity(c) },
	})
	srv = server.New(cfg, k, d, st, m)
	if err := srv.LoadSettings(ctx); err != nil {
		return err
	}
	go m.Run(ctx)

	hs := &http.Server{Addr: cfg.Listen, Handler: srv.Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	slog.Info("tems-api listening", "addr", cfg.Listen, "issuer", cfg.Issuer())
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// bootstrapRealm lets admins store the console's extra profile fields
// (department, job title, phone) on users via the declarative user profile.
func bootstrapRealm(ctx context.Context, k *kc.Client) error {
	var up map[string]any
	if _, err := k.Do(ctx, http.MethodGet, "/users/profile", nil, &up); err != nil {
		return err
	}
	if up["unmanagedAttributePolicy"] == "ADMIN_EDIT" {
		return nil
	}
	up["unmanagedAttributePolicy"] = "ADMIN_EDIT"
	_, err := k.Do(ctx, http.MethodPut, "/users/profile", up, nil)
	return err
}

func retry(ctx context.Context, what string, fn func() error) error {
	var err error
	for i := 0; i < 60; i++ {
		if err = fn(); err == nil {
			return nil
		}
		slog.Info("waiting for "+what, "attempt", i+1, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return err
}
