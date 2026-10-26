package server

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"techzaz.lk/tems-api/internal/dir"
	"techzaz.lk/tems-api/internal/kc"
	tmail "techzaz.lk/tems-api/internal/mail"
)

type apiGroup struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
	MemberCount int      `json:"memberCount"`
	CreatedAt   string   `json:"createdAt"`
}

func toGroup(g *dir.Group) apiGroup {
	return apiGroup{ID: g.ID, Name: g.Name, Description: g.Description, Permissions: nz(g.Perms), MemberCount: len(g.Members), CreatedAt: g.CreatedAt}
}

func (s *Server) listGroups(c *call) error {
	if err := c.need("groups:view", "users:view", "permissions:view", "mail:send"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	out := []apiGroup{}
	for _, g := range sn.Groups {
		out = append(out, toGroup(g))
	}
	return c.JSON(200, out)
}

func (c *call) roles(sn *dir.Snapshot, keys []string) []kc.Role {
	var out []kc.Role
	for _, k := range keys {
		if r, ok := sn.PermSet[k]; ok {
			out = append(out, kc.Role{ID: r.ID, Name: r.Name, ClientRole: true, ContainerID: r.ContainerID})
		}
	}
	return out
}

func nameTaken(sn *dir.Snapshot, name, exceptID string) bool {
	for _, g := range sn.Groups {
		if g.ID != exceptID && strings.EqualFold(g.Name, name) {
			return true
		}
	}
	return false
}

func (s *Server) createGroup(c *call) error {
	if err := c.need("groups:create"); err != nil {
		return err
	}
	var in struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Permissions []string `json:"permissions"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if len(in.Name) < 2 || strings.Contains(in.Name, "/") {
		return errf(400, "Group name must be at least 2 characters and cannot contain “/”.")
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	if nameTaken(sn, in.Name, "") {
		return errf(409, "A group named “%s” already exists.", in.Name)
	}
	var perms []string
	for _, p := range in.Permissions {
		if _, ok := sn.PermSet[p]; ok {
			perms = append(perms, p)
		}
	}
	if len(perms) > 0 {
		if err := c.need("permissions:manage"); err != nil {
			return err
		}
		if err := c.canGrant(perms); err != nil {
			return err
		}
	}
	rep := kc.Group{Name: in.Name, Attributes: map[string][]string{
		"description": {strings.TrimSpace(in.Description)},
		"createdAt":   {time.Now().UTC().Format(time.RFC3339)},
	}}
	hdr, err := s.kc.Do(c.ctx(), http.MethodPost, "/groups", rep, nil)
	if err != nil {
		return err
	}
	id := kc.IDFromLocation(hdr)
	if len(perms) > 0 {
		if _, err := s.kc.Do(c.ctx(), http.MethodPost, "/groups/"+kc.P(id)+"/role-mappings/clients/"+kc.P(s.dir.ClientID), c.roles(sn, perms), nil); err != nil {
			return err
		}
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	g, err := c.group(sn, id)
	if err != nil {
		return err
	}
	c.audit("group.create", "group", id, g.Name, "Created group "+g.Name, map[string]any{"permissions": perms})
	return c.JSON(201, toGroup(g))
}

func (s *Server) updateGroup(c *call) error {
	if err := c.need("groups:edit"); err != nil {
		return err
	}
	var in struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	var raw map[string]any
	if _, err := s.kc.Do(c.ctx(), http.MethodGet, "/groups/"+kc.P(g.ID), nil, &raw); err != nil {
		return err
	}
	attrs, _ := raw["attributes"].(map[string]any)
	if attrs == nil {
		attrs = map[string]any{}
	}
	oldName := g.Name
	renamed, described := false, false
	if in.Name != nil && strings.TrimSpace(*in.Name) != g.Name {
		n := strings.TrimSpace(*in.Name)
		if len(n) < 2 || strings.Contains(n, "/") {
			return errf(400, "Group name must be at least 2 characters and cannot contain “/”.")
		}
		if nameTaken(sn, n, g.ID) {
			return errf(409, "A group named “%s” already exists.", n)
		}
		raw["name"], renamed = n, true
	}
	if in.Description != nil && strings.TrimSpace(*in.Description) != g.Description {
		attrs["description"], described = []string{strings.TrimSpace(*in.Description)}, true
	}
	if !renamed && !described {
		return c.JSON(200, toGroup(g))
	}
	raw["attributes"] = attrs
	if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/groups/"+kc.P(g.ID), raw, nil); err != nil {
		return err
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	ng, err := c.group(sn, g.ID)
	if err != nil {
		return err
	}
	if renamed {
		c.audit("group.rename", "group", g.ID, ng.Name, "Renamed group "+oldName+" → "+ng.Name, map[string]any{"from": oldName, "to": ng.Name})
		c.notify("group.renamed", sn.Members(g.ID), func(*kc.User) tmail.Data { return tmail.Data{Group: oldName, NewName: ng.Name} }, false)
	}
	if described {
		c.audit("group.update", "group", g.ID, ng.Name, "Updated description of "+ng.Name, nil)
	}
	return c.JSON(200, toGroup(ng))
}

func (s *Server) deleteGroup(c *call) error {
	if err := c.need("groups:delete"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	members := sn.Members(g.ID)
	before := map[string]map[string]bool{}
	for _, u := range members {
		before[u.ID] = sn.Effective(u.ID)
	}
	if _, err := s.kc.Do(c.ctx(), http.MethodDelete, "/groups/"+kc.P(g.ID), nil, nil); err != nil {
		return err
	}
	after, err := c.changed()
	if err != nil {
		return err
	}
	c.audit("group.delete", "group", g.ID, g.Name, "Deleted group "+g.Name, map[string]any{"members": len(members)})
	c.notify("group.deleted", members, func(u *kc.User) tmail.Data {
		_, removed := dir.Diff(before[u.ID], after.Effective(u.ID))
		return tmail.Data{Group: g.Name, Removed: removed}
	}, false)
	return c.NoContent()
}

func (s *Server) groupMembers(c *call) error {
	if err := c.need("groups:view"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	out := []apiUser{}
	for _, u := range sn.Members(g.ID) {
		out = append(out, toUser(sn, u))
	}
	return c.JSON(200, out)
}

func (s *Server) addMembers(c *call) error {
	if err := c.need("groups:members"); err != nil {
		return err
	}
	var in struct {
		UserIDs []string `json:"userIds"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	if err := c.canGrant(g.Perms); err != nil {
		return err
	}
	var added []*kc.User
	before := map[string]map[string]bool{}
	for _, uid := range in.UserIDs {
		u, err := c.user(sn, uid)
		if err != nil {
			return err
		}
		if sn.InGroup(u.ID, g.ID) {
			continue
		}
		if err := c.guardTarget(sn, u, true); err != nil {
			return err
		}
		before[u.ID] = sn.Effective(u.ID)
		added = append(added, u)
	}
	for _, u := range added {
		if _, err := s.kc.Do(c.ctx(), http.MethodPut, "/users/"+kc.P(u.ID)+"/groups/"+kc.P(g.ID), nil, nil); err != nil {
			return err
		}
	}
	if len(added) == 0 {
		return c.NoContent()
	}
	after, err := c.changed()
	if err != nil {
		return err
	}
	names := make([]string, len(added))
	for i, u := range added {
		names[i] = u.Username
	}
	c.audit("group.members.add", "group", g.ID, g.Name, "Added "+strings.Join(names, ", ")+" to "+g.Name, map[string]any{"users": names})
	c.notify("group.member_added", added, func(u *kc.User) tmail.Data {
		gained, _ := dir.Diff(before[u.ID], after.Effective(u.ID))
		return tmail.Data{Group: g.Name, Added: gained}
	}, false)
	return c.NoContent()
}

func (s *Server) removeMember(c *call) error {
	if err := c.need("groups:members"); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	u, err := c.user(sn, c.param("uid"))
	if err != nil {
		return err
	}
	if err := c.guardTarget(sn, u, true); err != nil {
		return err
	}
	before := sn.Effective(u.ID)
	if _, err := s.kc.Do(c.ctx(), http.MethodDelete, "/users/"+kc.P(u.ID)+"/groups/"+kc.P(g.ID), nil, nil); err != nil {
		return err
	}
	after, err := c.changed()
	if err != nil {
		return err
	}
	_, lost := dir.Diff(before, after.Effective(u.ID))
	c.audit("group.members.remove", "group", g.ID, g.Name, "Removed "+u.Username+" from "+g.Name, map[string]any{"user": u.Username})
	c.notify("group.member_removed", one(u), func(*kc.User) tmail.Data { return tmail.Data{Group: g.Name, Removed: lost} }, false)
	return c.NoContent()
}

// setGroupPermissions replaces the group's permission set; members get one email with the diff.
func (s *Server) setGroupPermissions(c *call) error {
	if err := c.need("permissions:manage"); err != nil {
		return err
	}
	var in struct {
		Permissions []string `json:"permissions"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	sn, err := c.snap()
	if err != nil {
		return err
	}
	g, err := c.group(sn, c.param("id"))
	if err != nil {
		return err
	}
	if !c.P.Super && sn.InGroup(c.P.ID, g.ID) {
		return errf(403, "You cannot change the permissions of a group you belong to.")
	}
	cur, next := map[string]bool{}, map[string]bool{}
	for _, p := range g.Perms {
		cur[p] = true
	}
	for _, p := range in.Permissions {
		if _, ok := sn.PermSet[p]; ok {
			next[p] = true
		}
	}
	added, removed := dir.Diff(cur, next)
	if err := c.canGrant(added); err != nil {
		return err
	}
	if len(added) == 0 && len(removed) == 0 {
		return c.JSON(200, toGroup(g))
	}
	path := "/groups/" + kc.P(g.ID) + "/role-mappings/clients/" + kc.P(s.dir.ClientID)
	if len(added) > 0 {
		if _, err := s.kc.Do(c.ctx(), http.MethodPost, path, c.roles(sn, added), nil); err != nil {
			return err
		}
	}
	if len(removed) > 0 {
		if _, err := s.kc.Do(c.ctx(), http.MethodDelete, path, c.roles(sn, removed), nil); err != nil {
			return err
		}
	}
	sn, err = c.changed()
	if err != nil {
		return err
	}
	ng, err := c.group(sn, g.ID)
	if err != nil {
		return err
	}
	var parts []string
	for _, k := range added {
		parts = append(parts, "+"+k)
	}
	for _, k := range removed {
		parts = append(parts, "−"+k)
	}
	sort.Strings(parts)
	c.audit("group.permissions.set", "group", g.ID, g.Name, g.Name+": "+strings.Join(parts, " "), map[string]any{"added": added, "removed": removed})
	c.notify("group.permissions_changed", sn.Members(g.ID), func(*kc.User) tmail.Data {
		return tmail.Data{Group: g.Name, Added: added, Removed: removed}
	}, false)
	return c.JSON(200, toGroup(ng))
}
