package server

import (
	"strings"
	"testing"
	"time"

	"techzaz.lk/tems-api/internal/store"
)

func TestProgressAndOverdue(t *testing.T) {
	p := &store.Project{Status: "active", DueDate: "2026-01-31", TicketCounts: map[string]int{"open": 1, "in_progress": 1, "resolved": 1, "closed": 1}}
	if got := progress(p); got != 50 {
		t.Errorf("progress = %d, want 50", got)
	}
	if !overdue(p, "2026-02-01") || overdue(p, "2026-01-31") {
		t.Error("overdue should flip the day after the due date")
	}
	p.Status = "completed"
	if progress(p) != 100 || overdue(p, "2027-01-01") {
		t.Error("completed projects are 100% and never overdue")
	}
	if progress(&store.Project{Status: "planning", TicketCounts: map[string]int{}}) != 0 {
		t.Error("no tickets means 0%")
	}
}

func TestSniffUpload(t *testing.T) {
	ok := map[string][]byte{
		"a.pdf":  []byte("%PDF-1.7\n..."),
		"a.png":  []byte("\x89PNG\r\n\x1a\n0000000000000"),
		"a.jpg":  []byte("\xff\xd8\xff\xe0000000000000"),
		"a.docx": []byte("PK\x03\x04" + strings.Repeat("0", 40)),
		"a.doc":  []byte("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1rest"),
	}
	for name, data := range ok {
		if _, err := sniffUpload(name, data); err != nil {
			t.Errorf("%s rejected: %v", name, err)
		}
	}
	bad := map[string][]byte{
		"a.html":    []byte("<html><script>alert(1)</script>"),
		"a.svg":     []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`),
		"a.zip":     []byte("PK\x03\x04" + strings.Repeat("0", 40)), // a zip that is not an Office file
		"fake.pdf":  []byte("MZ\x90\x00 an exe renamed"),
		"a.exe.png": []byte("MZ\x90\x00"),
	}
	for name, data := range bad {
		if _, err := sniffUpload(name, data); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestSafeFilename(t *testing.T) {
	cases := map[string]string{
		`..\..\etc\passwd`:       "passwd",
		"/tmp/x/report.pdf":      "report.pdf",
		"in\x00voice\n.pdf":      "invoice.pdf",
		`a"b<c>d|e?.png`:         "abcde.png",
		"":                       "document",
		strings.Repeat("x", 300): strings.Repeat("x", 120),
	}
	for in, want := range cases {
		if got := safeFilename(in); got != want {
			t.Errorf("safeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSignedCopyEscapes(t *testing.T) {
	now := time.Now()
	e := &store.Employee{FirstName: "<i>Ann</i>", Email: "ann@example.com", Code: "TZ-0001"}
	a := &store.Agreement{Title: "Offer <script>", Body: "Clause one.\n\n<img src=x onerror=alert(1)>", SignerName: "Ann", SignedAt: &now}
	out := string(signedCopy("Techzaz", e, a))
	for _, bad := range []string{"<script>", "<img src=x", "<i>Ann</i>"} {
		if strings.Contains(out, bad) {
			t.Errorf("signed copy contains unescaped %q", bad)
		}
	}
	if !strings.Contains(out, "Clause one.") {
		t.Error("body missing from signed copy")
	}
}

func TestValidDate(t *testing.T) {
	for in, want := range map[string]bool{"": true, "2026-02-28": true, "2026-02-30": false, "26-1-1": false, "2026-13-01": false} {
		if validDate(in) != want {
			t.Errorf("validDate(%q) != %v", in, want)
		}
	}
}
