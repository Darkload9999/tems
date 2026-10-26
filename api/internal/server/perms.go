package server

import (
	"net/http"
	"regexp"
	"strings"

	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
)

type apiPermission struct {
	Key         string `json:"key"`
	Description string `json:"description"`
	Category    string `json:"category"`
	System      bool   `json:"system"`
}

func toPerm(r kc.Role) apiPermission {
	cat := r.Attr("category")
	if cat == "" {
		cat = "Custom"
	}
	return apiPermission{Key: r.Name, Description: r.Description, Category: cat, System: r.Attr("system") == "true"}
}

var permKeyRe = regexp.MustCompile(`^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`)

func (s *Server) listPermissions(c *call) error {
	if err := c.need("permissions:view", "groups:view", "users:view"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	out := []apiPermission{}
	for _, r := range sn.Perms {
		out = append(out, toPerm(r))
	}
	return c.JSON(200, out)
}

func (s *Server) rolesPath(name string) string {
	p := "/clients/" + kc.P(s.dir.ClientID) + "/roles"
	if name != "" {
		p += "/" + kc.P(name)
	}
	return p
}

func (s *Server) createPermission(c *call) error {
	if err := c.needSuper(); err != nil {
		return err
	}
	var in apiPermission
	if err := c.decode(&in); err != nil {
		return err
	}
	in.Key = strings.ToLower(strings.TrimSpace(in.Key))
	if !permKeyRe.MatchString(in.Key) {
		return errf(400, "Use the form resource:action, e.g. reports:export.")
	}
	if strings.TrimSpace(in.Description) == "" {
		return errf(400, "Add a description.")
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	if _, ok := sn.PermSet[in.Key]; ok {
		return errf(409, "The permission “%s” already exists.", in.Key)
	}
	cat := strings.TrimSpace(in.Category)
	if cat == "" {
		cat = "Custom"
	}
	role := kc.Role{Name: in.Key, Description: strings.TrimSpace(in.Description), Attributes: map[string][]string{"system": {"false"}, "category": {cat}}}
	if _, err := s.kc.Do(c.ctx(), http.MethodPost, s.rolesPath(""), role, nil); err != nil {
		return err
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	c.audit("permission.create", "permission", in.Key, in.Key, "Created permission "+in.Key, map[string]any{"category": cat})
	return c.JSON(201, toPerm(sn.PermSet[in.Key]))
}

func (s *Server) updatePermission(c *call) error {
	if err := c.needSuper(); err != nil {
		return err
	}
	var in struct {
		Description string `json:"description"`
		Category    string `json:"category"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	key := c.param("key")
	r, ok := sn.PermSet[key]
	if !ok {
		return errf(404, "Permission not found.")
	}
	if r.Attr("system") == "true" {
		return errf(403, "Built-in permissions cannot be edited.")
	}
	cat := strings.TrimSpace(in.Category)
	if cat == "" {
		cat = "Custom"
	}
	rep := kc.Role{Name: key, Description: strings.TrimSpace(in.Description), Attributes: map[string][]string{"system": {"false"}, "category": {cat}}}
	if _, err := s.kc.Do(c.ctx(), http.MethodPut, s.rolesPath(key), rep, nil); err != nil {
		return err
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	c.audit("permission.update", "permission", key, key, "Updated permission "+key, nil)
	return c.JSON(200, toPerm(sn.PermSet[key]))
}

func (s *Server) deletePermission(c *call) error {
	if err := c.needSuper(); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	key := c.param("key")
	r, ok := sn.PermSet[key]
	if !ok {
		return errf(404, "Permission not found.")
	}
	if r.Attr("system") == "true" {
		return errf(403, "Built-in permissions cannot be deleted.")
	}
	var losers []*kc.User
	for _, u := range sn.Users {
		if !sn.Supers[u.ID] && sn.Effective(u.ID)[key] {
			losers = append(losers, u)
		}
	}
	// Keycloak removes the role from every group and user mapping with it.
	if _, err := s.kc.Do(c.ctx(), http.MethodDelete, s.rolesPath(key), nil, nil); err != nil {
		return err
	}
	_ = s.st.DeleteDeniesForPerm(c.ctx(), key)
	s.dir.Invalidate()
	c.audit("permission.delete", "permission", key, key, "Deleted permission "+key, map[string]any{"affectedUsers": len(losers)})
	c.notify("member.permissions_changed", losers, func(*kc.User) tmail.Data { return tmail.Data{Removed: []string{key}} }, false)
	return c.NoContent()
}

/* ---------- member-level overrides ---------- */

type apiMemberPerm struct {
	Key         string   `json:"key"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	FromGroups  []string `json:"fromGroups"`
	State       string   `json:"state"` // deny | inherit | allow
	Effective   bool     `json:"effective"`
}

func memberPerms(sn *dir.Snapshot, uid string) []apiMemberPerm {
	from := sn.GroupPerms(uid)
	eff := sn.Effective(uid)
	out := []apiMemberPerm{}
	for _, r := range sn.Perms {
		p := toPerm(r)
		state := "inherit"
		if dir.Contains(sn.Denies[uid], r.Name) {
			state = "deny"
		} else if dir.Contains(sn.Grants[uid], r.Name) {
			state = "allow"
		}
		out = append(out, apiMemberPerm{Key: r.Name, Description: p.Description, Category: p.Category, FromGroups: nz(from[r.Name]), State: state, Effective: eff[r.Name]})
	}
	return out
}

func (s *Server) memberPermissions(c *call) error {
	id := c.param("id")
	if id != c.P.ID {
		if err := c.need("permissions:view", "users:view"); err != nil {
			return err
		}
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	if _, err := c.user(sn, id); err != nil {
		return err
	}
	return c.JSON(200, memberPerms(sn, id))
}

func (s *Server) setMemberPermission(c *call) error {
	if err := c.need("permissions:manage"); err != nil {
		return err
	}
	var in struct {
		State string `json:"state"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	if in.State != "allow" && in.State != "deny" && in.State != "inherit" {
		return errf(400, "State must be allow, deny or inherit.")
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("id"))
	if err != nil {
		return err
	}
	if err := c.guardTarget(sn, u, true); err != nil {
		return err
	}
	key := c.param("key")
	if _, ok := sn.PermSet[key]; !ok {
		return errf(404, "Unknown permission.")
	}
	if in.State == "allow" {
		if err := c.canGrant([]string{key}); err != nil {
			return err
		}
	}
	before := sn.Effective(u.ID)
	path := "/users/" + kc.P(u.ID) + "/role-mappings/clients/" + kc.P(s.dir.ClientID)
	granted := dir.Contains(sn.Grants[u.ID], key)
	if granted && in.State != "allow" {
		if _, err := s.kc.Do(c.ctx(), http.MethodDelete, path, c.roles(sn, []string{key}), nil); err != nil {
			return err
		}
	}
	if !granted && in.State == "allow" {
		if _, err := s.kc.Do(c.ctx(), http.MethodPost, path, c.roles(sn, []string{key}), nil); err != nil {
			return err
		}
	}
	if err := s.st.SetDeny(c.ctx(), u.ID, key, in.State == "deny"); err != nil {
		return err
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	added, removed := dir.Diff(before, sn.Effective(u.ID))
	label := map[string]string{"allow": "Allowed", "deny": "Denied", "inherit": "Reset to inherited"}[in.State]
	c.audit("member.permission.set", "user", u.ID, u.Username, label+" "+key+" for "+u.Username,
		map[string]any{"key": key, "state": in.State, "added": added, "removed": removed})
	if len(added)+len(removed) > 0 {
		c.notify("member.permissions_changed", one(u), func(*kc.User) tmail.Data { return tmail.Data{Added: added, Removed: removed} }, false)
	}
	return c.JSON(200, memberPerms(sn, u.ID))
}
