// Package dir builds a consistent snapshot of the directory (users, groups,
// memberships, permission grants, denies, super admins, last sign-ins) from
// Keycloak + the store, and computes effective permissions from it.
//
// Effective(user) = super admin ? every permission
//
//	: (∪ permissions of the user's groups) ∪ direct grants − denies
package dir

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"techzaz.lk/tems-api/internal/kc"
	"techzaz.lk/tems-api/internal/store"
)

const SuperAdminRole = "super-admin"

type Group struct {
	ID          string
	Name        string
	Description string
	CreatedAt   string
	Perms       []string // client roles mapped to the group
	Members     []string // user ids
}

type Snapshot struct {
	Users      []*kc.User
	ByID       map[string]*kc.User
	Groups     []*Group
	GroupByID  map[string]*Group
	UserGroups map[string][]string // user id → group ids
	Grants     map[string][]string // user id → directly granted permissions
	Denies     map[string][]string // user id → denied permissions
	Supers     map[string]bool
	Perms      []kc.Role // the permission catalog (tems-api client roles)
	PermSet    map[string]kc.Role
	LastLogin  map[string]time.Time
}

type Dir struct {
	kc       *kc.Client
	st       *store.Store
	ClientID string // UUID of the tems-api client

	mu   sync.Mutex
	snap *Snapshot
	at   time.Time
}

const ttl = 5 * time.Second

func New(k *kc.Client, st *store.Store, clientUUID string) *Dir {
	return &Dir{kc: k, st: st, ClientID: clientUUID}
}

// Invalidate forces the next Get to rebuild (call after every write).
func (d *Dir) Invalidate() { d.mu.Lock(); d.snap = nil; d.mu.Unlock() }

func (d *Dir) Get(ctx context.Context) (*Snapshot, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.snap != nil && time.Since(d.at) < ttl {
		return d.snap, nil
	}
	s, err := d.build(ctx)
	if err != nil {
		return nil, err
	}
	d.snap, d.at = s, time.Now()
	return s, nil
}

func (d *Dir) build(ctx context.Context) (*Snapshot, error) {
	s := &Snapshot{
		ByID: map[string]*kc.User{}, GroupByID: map[string]*Group{}, UserGroups: map[string][]string{},
		Grants: map[string][]string{}, Supers: map[string]bool{}, PermSet: map[string]kc.Role{}, LastLogin: map[string]time.Time{},
	}
	var (
		users  []*kc.User
		groups []kc.Group
		supers []kc.User
		events []kc.Event
	)
	cid := kc.P(d.ClientID)
	if err := parallel(
		func() error {
			_, err := d.kc.Do(ctx, http.MethodGet, "/users?briefRepresentation=false&max=100000", nil, &users)
			return err
		},
		func() error {
			_, err := d.kc.Do(ctx, http.MethodGet, "/groups?briefRepresentation=false&max=10000", nil, &groups)
			return err
		},
		func() error {
			_, err := d.kc.Do(ctx, http.MethodGet, "/clients/"+cid+"/roles?briefRepresentation=false", nil, &s.Perms)
			return err
		},
		func() error {
			_, err := d.kc.Do(ctx, http.MethodGet, "/roles/"+SuperAdminRole+"/users?max=100000", nil, &supers)
			return err
		},
		func() error {
			// Last sign-ins come from Keycloak's stored LOGIN events (newest first).
			_, err := d.kc.Do(ctx, http.MethodGet, "/events?type=LOGIN&max=5000", nil, &events)
			if err != nil {
				events = nil
			} // events are cosmetic; never fail the snapshot over them
			return nil
		},
		func() (err error) { s.Denies, err = d.st.Denies(ctx); return },
	); err != nil {
		return nil, err
	}

	for _, u := range users {
		if u.ServiceAccount != "" || strings.HasPrefix(u.Username, "service-account-") {
			continue
		}
		s.Users = append(s.Users, u)
		s.ByID[u.ID] = u
	}
	for _, u := range supers {
		s.Supers[u.ID] = true
	}
	for _, e := range events {
		if _, ok := s.LastLogin[e.UserID]; !ok {
			s.LastLogin[e.UserID] = time.UnixMilli(e.Time)
		}
	}
	sort.Slice(s.Perms, func(i, j int) bool { return s.Perms[i].Name < s.Perms[j].Name })
	for _, p := range s.Perms {
		s.PermSet[p.Name] = p
	}

	// per group: members + mapped permissions; per permission: direct holders
	var mu sync.Mutex
	var jobs []func() error
	for _, g := range groups {
		g := g
		grp := &Group{ID: g.ID, Name: g.Name, Description: g.Attr("description"), CreatedAt: g.Attr("createdAt")}
		s.Groups = append(s.Groups, grp)
		s.GroupByID[g.ID] = grp
		jobs = append(jobs, func() error {
			var members []kc.User
			var roles []kc.Role
			if _, err := d.kc.Do(ctx, http.MethodGet, "/groups/"+kc.P(g.ID)+"/members?briefRepresentation=true&max=100000", nil, &members); err != nil {
				return err
			}
			if _, err := d.kc.Do(ctx, http.MethodGet, "/groups/"+kc.P(g.ID)+"/role-mappings/clients/"+cid, nil, &roles); err != nil {
				return err
			}
			mu.Lock()
			defer mu.Unlock()
			for _, m := range members {
				grp.Members = append(grp.Members, m.ID)
				s.UserGroups[m.ID] = append(s.UserGroups[m.ID], g.ID)
			}
			for _, r := range roles {
				grp.Perms = append(grp.Perms, r.Name)
			}
			sort.Strings(grp.Perms)
			return nil
		})
	}
	for _, p := range s.Perms {
		p := p
		jobs = append(jobs, func() error {
			var holders []kc.User
			if _, err := d.kc.Do(ctx, http.MethodGet, "/clients/"+cid+"/roles/"+kc.P(p.Name)+"/users?max=100000", nil, &holders); err != nil {
				return err
			}
			mu.Lock()
			defer mu.Unlock()
			for _, h := range holders {
				s.Grants[h.ID] = append(s.Grants[h.ID], p.Name)
			}
			return nil
		})
	}
	if err := parallel(jobs...); err != nil {
		return nil, err
	}
	sort.Slice(s.Groups, func(i, j int) bool { return strings.ToLower(s.Groups[i].Name) < strings.ToLower(s.Groups[j].Name) })
	for _, v := range s.Grants {
		sort.Strings(v)
	}
	return s, nil
}

// parallel runs fns concurrently (at most 8 at a time) and returns the first error.
func parallel(fns ...func() error) error {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	errs := make(chan error, len(fns))
	for _, f := range fns {
		wg.Add(1)
		sem <- struct{}{}
		go func(f func() error) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := f(); err != nil {
				errs <- err
			}
		}(f)
	}
	wg.Wait()
	close(errs)
	return <-errs
}

/* ---------- queries on a snapshot ---------- */

// GroupPerms is the union of permissions from all of the user's groups.
func (s *Snapshot) GroupPerms(uid string) map[string][]string {
	out := map[string][]string{} // perm → group names
	for _, gid := range s.UserGroups[uid] {
		g := s.GroupByID[gid]
		if g == nil {
			continue
		}
		for _, p := range g.Perms {
			out[p] = append(out[p], g.Name)
		}
	}
	return out
}

func (s *Snapshot) Effective(uid string) map[string]bool {
	eff := map[string]bool{}
	if s.Supers[uid] {
		for _, p := range s.Perms {
			eff[p.Name] = true
		}
		return eff
	}
	for p := range s.GroupPerms(uid) {
		eff[p] = true
	}
	for _, p := range s.Grants[uid] {
		eff[p] = true
	}
	for _, p := range s.Denies[uid] {
		delete(eff, p)
	}
	for p := range eff {
		if _, ok := s.PermSet[p]; !ok {
			delete(eff, p)
		}
	}
	return eff
}

func (s *Snapshot) Members(gid string) []*kc.User {
	g := s.GroupByID[gid]
	if g == nil {
		return nil
	}
	var out []*kc.User
	for _, id := range g.Members {
		if u := s.ByID[id]; u != nil {
			out = append(out, u)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].FullName()) < strings.ToLower(out[j].FullName()) })
	return out
}

func (s *Snapshot) InGroup(uid, gid string) bool {
	for _, g := range s.UserGroups[uid] {
		if g == gid {
			return true
		}
	}
	return false
}

func Contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Diff returns permissions added and removed going from before to after.
func Diff(before, after map[string]bool) (added, removed []string) {
	added, removed = []string{}, []string{}
	for p := range after {
		if !before[p] {
			added = append(added, p)
		}
	}
	for p := range before {
		if !after[p] {
			removed = append(removed, p)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return
}
