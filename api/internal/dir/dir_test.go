package dir

import (
	"reflect"
	"sort"
	"testing"

	"techzaz.lk/tems-api/internal/kc"
)

func snapshot() *Snapshot {
	s := &Snapshot{
		GroupByID:  map[string]*Group{},
		UserGroups: map[string][]string{"ann": {"g1", "g2"}, "ben": {"g1"}},
		Grants:     map[string][]string{"ben": {"mail:send", "gone:perm"}},
		Denies:     map[string][]string{"ann": {"users:edit"}},
		Supers:     map[string]bool{"root": true},
		PermSet:    map[string]kc.Role{},
	}
	for _, p := range []string{"users:view", "users:edit", "groups:view", "mail:send"} {
		s.Perms = append(s.Perms, kc.Role{Name: p})
		s.PermSet[p] = kc.Role{Name: p}
	}
	s.GroupByID["g1"] = &Group{ID: "g1", Name: "Staff", Perms: []string{"users:view"}}
	s.GroupByID["g2"] = &Group{ID: "g2", Name: "Support", Perms: []string{"users:view", "users:edit", "groups:view"}}
	return s
}

func keys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestEffective(t *testing.T) {
	s := snapshot()
	cases := map[string][]string{
		"ann":    {"groups:view", "users:view"},                            // groups ∪ − deny users:edit
		"ben":    {"mail:send", "users:view"},                              // group + direct grant; unknown perm dropped
		"root":   {"groups:view", "mail:send", "users:edit", "users:view"}, // super admin: everything
		"nobody": {},
	}
	for uid, want := range cases {
		if got := keys(s.Effective(uid)); !reflect.DeepEqual(got, want) {
			t.Errorf("Effective(%s) = %v, want %v", uid, got, want)
		}
	}
}

func TestGroupPermsNamesSources(t *testing.T) {
	got := snapshot().GroupPerms("ann")["users:view"]
	if !reflect.DeepEqual(got, []string{"Staff", "Support"}) {
		t.Errorf("GroupPerms sources = %v", got)
	}
}

func TestDiff(t *testing.T) {
	added, removed := Diff(map[string]bool{"a": true, "b": true}, map[string]bool{"b": true, "c": true})
	if !reflect.DeepEqual(added, []string{"c"}) || !reflect.DeepEqual(removed, []string{"a"}) {
		t.Errorf("Diff = +%v -%v", added, removed)
	}
	added, removed = Diff(nil, nil)
	if added == nil || removed == nil || len(added)+len(removed) != 0 {
		t.Errorf("Diff of empty sets should be empty, non-nil slices")
	}
}
