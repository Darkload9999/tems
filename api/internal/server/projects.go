package server

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	tmail "techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/store"
)

var (
	projectStatuses = map[string]string{"planning": "Planning", "active": "Active", "on_hold": "On hold", "completed": "Completed", "cancelled": "Cancelled"}
	projectHealth   = map[string]string{"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}
	ticketStatuses  = []string{"open", "in_progress", "in_review", "resolved", "closed"}
	projectKeyRe    = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)
)

type apiProject struct {
	ID           string                `json:"id"`
	Key          string                `json:"key"`
	Name         string                `json:"name"`
	Description  string                `json:"description"`
	Client       string                `json:"client"`
	Status       string                `json:"status"`
	Health       string                `json:"health"`
	StartDate    string                `json:"startDate"`
	DueDate      string                `json:"dueDate"`
	LeadID       *string               `json:"leadId"`
	LeadName     string                `json:"leadName"`
	Members      []store.ProjectMember `json:"members"`
	TicketCounts map[string]int        `json:"ticketCounts"`
	Progress     int                   `json:"progress"`
	Overdue      bool                  `json:"overdue"`
	CreatedAt    time.Time             `json:"createdAt"`
	UpdatedAt    time.Time             `json:"updatedAt"`
}

// progress is the share of resolved + closed tickets; completed projects are 100%.
func progress(p *store.Project) int {
	if p.Status == "completed" {
		return 100
	}
	total, done := 0, p.TicketCounts["resolved"]+p.TicketCounts["closed"]
	for _, n := range p.TicketCounts {
		total += n
	}
	if total == 0 {
		return 0
	}
	return int(math.Round(float64(done) * 100 / float64(total)))
}

func overdue(p *store.Project, today string) bool {
	return p.DueDate != "" && p.DueDate < today && p.Status != "completed" && p.Status != "cancelled"
}

func toProject(p *store.Project) apiProject {
	counts := map[string]int{}
	for _, st := range ticketStatuses {
		counts[st] = p.TicketCounts[st]
	}
	return apiProject{
		ID: p.ID, Key: p.Key, Name: p.Name, Description: p.Description, Client: p.Client, Status: p.Status, Health: p.Health,
		StartDate: p.StartDate, DueDate: p.DueDate, LeadID: p.LeadID, LeadName: p.LeadName, Members: p.Members, TicketCounts: counts,
		Progress: progress(p), Overdue: overdue(p, time.Now().Format("2006-01-02")), CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

// onProject reports whether the employee leads or belongs to the project.
func onProject(p *store.Project, employeeID string) bool {
	if employeeID == "" {
		return false
	}
	if p.LeadID != nil && *p.LeadID == employeeID {
		return true
	}
	for _, m := range p.Members {
		if m.EmployeeID == employeeID {
			return true
		}
	}
	return false
}

func (c *call) myEmployeeID() string {
	if e := c.myEmployee(); e != nil {
		return e.ID
	}
	return ""
}

// project loads the {id} project; without projects:view the caller must be on it.
func (c *call) project(id string) (*store.Project, error) {
	p, err := c.s.st.GetProject(c.ctx(), id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, errf(404, "Project not found.")
	}
	if err != nil {
		return nil, err
	}
	if !c.P.Can("projects:view") && !onProject(p, c.myEmployeeID()) {
		return nil, errf(403, "You need the “projects:view” permission to do that.")
	}
	return p, nil
}

// projectTeam is everyone on the project, as email recipients.
func (c *call) projectTeam(p *store.Project) []recipient {
	var rs []recipient
	ids := map[string]bool{}
	for _, m := range p.Members {
		ids[m.EmployeeID] = true
		r := recipient{Email: m.Email, Name: m.Name, First: firstWord(m.Name)}
		if m.UserID != nil {
			r.UserID = *m.UserID
		}
		rs = append(rs, r)
	}
	if p.LeadID != nil && !ids[*p.LeadID] {
		if e, err := c.s.st.GetEmployee(c.ctx(), *p.LeadID); err == nil {
			rs = append(rs, empRcpt(e))
		}
	}
	return rs
}

func firstWord(s string) string {
	f, _, _ := strings.Cut(strings.TrimSpace(s), " ")
	return f
}

func (s *Server) workLink() string { return s.cfg.PublicURL + "/work/" }

/* ---------- list / get ---------- */

func (s *Server) listProjects(c *call) error {
	memberOf := ""
	if c.query("mine") == "true" || !c.P.Can("projects:view") {
		if c.query("mine") != "true" {
			return errf(403, "You need the “projects:view” permission to do that.")
		}
		if memberOf = c.myEmployeeID(); memberOf == "" {
			return c.JSON(200, []apiProject{})
		}
	}
	list, err := s.st.ListProjects(c.ctx(), c.query("search"), c.query("status"), memberOf)
	if err != nil {
		return err
	}
	out := []apiProject{}
	for _, p := range list {
		out = append(out, toProject(p))
	}
	return c.JSON(200, out)
}

func (s *Server) getProject(c *call) error {
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	return c.JSON(200, toProject(p))
}

/* ---------- create / update / delete ---------- */

type projectInput struct {
	Key         *string `json:"key"`
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Client      *string `json:"client"`
	StartDate   *string `json:"startDate"`
	DueDate     *string `json:"dueDate"`
	LeadID      *string `json:"leadId"`
}

func (c *call) applyProject(in projectInput, p *store.Project) error {
	str := func(dst *string, v *string, n int) {
		if v != nil {
			*dst = clip(*v, n)
		}
	}
	str(&p.Name, in.Name, 120)
	str(&p.Description, in.Description, 4000)
	str(&p.Client, in.Client, 120)
	str(&p.StartDate, in.StartDate, 10)
	str(&p.DueDate, in.DueDate, 10)
	if in.LeadID != nil {
		if *in.LeadID == "" {
			p.LeadID = nil
		} else {
			e, err := c.s.st.GetEmployee(c.ctx(), *in.LeadID)
			if err != nil || e.Stage == "offboarded" {
				return errf(400, "Choose a current employee as the project lead.")
			}
			p.LeadID = &e.ID
		}
	}
	if p.Name == "" {
		return errf(400, "Give the project a name.")
	}
	if !validDate(p.StartDate) || !validDate(p.DueDate) {
		return errf(400, "Dates must be in the form YYYY-MM-DD.")
	}
	if p.StartDate != "" && p.DueDate != "" && p.DueDate < p.StartDate {
		return errf(400, "The due date must be after the start date.")
	}
	return nil
}

func (s *Server) createProject(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	var in projectInput
	if err := c.decode(&in); err != nil {
		return err
	}
	p := &store.Project{}
	if in.Key != nil {
		p.Key = strings.ToUpper(strings.TrimSpace(*in.Key))
	}
	if !projectKeyRe.MatchString(p.Key) {
		return errf(400, "The key must be 2–10 letters or digits starting with a letter, e.g. TEMS. It prefixes ticket numbers.")
	}
	if err := c.applyProject(in, p); err != nil {
		return err
	}
	id, err := s.st.CreateProject(c.ctx(), p)
	if errors.Is(err, store.ErrConflict) {
		return errf(409, "Another project already uses the key %s.", p.Key)
	}
	if err != nil {
		return err
	}
	_ = s.st.AddProjectUpdate(c.ctx(), store.ProjectUpdate{ProjectID: id, Author: c.P.Name, Status: "planning", Health: "on_track", Note: "Project created."})
	p, err = s.st.GetProject(c.ctx(), id)
	if err != nil {
		return err
	}
	if p.LeadID != nil {
		if e, err := s.st.GetEmployee(c.ctx(), *p.LeadID); err == nil {
			c.notifyTo("project.assigned", c.others([]recipient{empRcpt(e)}), func(recipient) tmail.Data {
				return tmail.Data{Project: p.Name, Role: "Project lead", Link: s.workLink()}
			}, false)
		}
	}
	c.audit("project.create", "project", p.ID, p.Name, "Created project "+p.Key+" · "+p.Name, nil)
	return c.JSON(201, toProject(p))
}

func (s *Server) updateProject(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	var in projectInput
	if err := c.decode(&in); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	oldLead := p.LeadID
	if err := c.applyProject(in, p); err != nil {
		return err
	}
	if err := s.st.UpdateProject(c.ctx(), p); err != nil {
		return err
	}
	p, _ = s.st.GetProject(c.ctx(), p.ID)
	if p.LeadID != nil && (oldLead == nil || *oldLead != *p.LeadID) {
		if e, err := s.st.GetEmployee(c.ctx(), *p.LeadID); err == nil {
			c.notifyTo("project.assigned", c.others([]recipient{empRcpt(e)}), func(recipient) tmail.Data {
				return tmail.Data{Project: p.Name, Role: "Project lead", Link: s.workLink()}
			}, false)
		}
	}
	c.audit("project.update", "project", p.ID, p.Name, "Updated project "+p.Name, nil)
	return c.JSON(200, toProject(p))
}

func (s *Server) deleteProject(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	if err := s.st.DeleteProject(c.ctx(), p.ID); err != nil {
		return err
	}
	n := 0
	for _, v := range p.TicketCounts {
		n += v
	}
	c.audit("project.delete", "project", p.ID, p.Name, fmt.Sprintf("Deleted project %s and its %d ticket%s", p.Name, n, plural(n)), nil)
	return c.NoContent()
}

/* ---------- status tracking ---------- */

func (s *Server) projectUpdates(c *call) error {
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	u, err := s.st.ProjectUpdates(c.ctx(), p.ID)
	if err != nil {
		return err
	}
	return c.JSON(200, u)
}

// postProjectUpdate records a status report (status, health, note) on the
// project's timeline. Managers and the project lead may post.
func (s *Server) postProjectUpdate(c *call) error {
	var in struct {
		Status string `json:"status"`
		Health string `json:"health"`
		Note   string `json:"note"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	if !c.P.Can("projects:manage") && (p.LeadID == nil || *p.LeadID != c.myEmployeeID()) {
		return errf(403, "Only project managers and the project lead can post status updates.")
	}
	if projectStatuses[in.Status] == "" || projectHealth[in.Health] == "" {
		return errf(400, "Choose a valid status and health.")
	}
	in.Note = clip(in.Note, 4000)
	if in.Note == "" && in.Status == p.Status && in.Health == p.Health {
		return errf(400, "Change the status or health, or write a note.")
	}
	before := p.Status
	p.Status = in.Status
	pct := progress(p)
	if err := s.st.SetProjectStatus(c.ctx(), p.ID, in.Status, in.Health); err != nil {
		return err
	}
	if err := s.st.AddProjectUpdate(c.ctx(), store.ProjectUpdate{ProjectID: p.ID, Author: c.P.Name, Status: in.Status, Health: in.Health, Progress: pct, Note: in.Note}); err != nil {
		return err
	}
	p, _ = s.st.GetProject(c.ctx(), p.ID)
	summary := fmt.Sprintf("%s: %s · %s", p.Name, projectStatuses[in.Status], projectHealth[in.Health])
	c.audit("project.status", "project", p.ID, p.Name, summary, map[string]any{"from": before, "to": in.Status, "health": in.Health, "progress": pct})
	c.notifyTo("project.status_changed", c.others(c.projectTeam(p)), func(recipient) tmail.Data {
		return tmail.Data{Project: p.Name, Note: in.Note, Link: s.workLink(), Changes: []string{
			"Status: " + projectStatuses[in.Status], "Health: " + projectHealth[in.Health], fmt.Sprintf("Progress: %d%%", pct)}}
	}, false)
	return c.JSON(200, toProject(p))
}

/* ---------- team ---------- */

type memberInput struct {
	EmployeeID string `json:"employeeId"`
	Role       string `json:"role"`
	Allocation int    `json:"allocation"`
}

func (in *memberInput) clean() error {
	in.Role = clip(in.Role, 80)
	if in.Allocation < 0 || in.Allocation > 100 {
		return errf(400, "Allocation must be between 0 and 100%%.")
	}
	return nil
}

func (s *Server) addProjectMember(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	var in memberInput
	if err := c.decode(&in); err != nil {
		return err
	}
	if err := in.clean(); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	e, err := s.st.GetEmployee(c.ctx(), in.EmployeeID)
	if err != nil || e.Stage == "offboarded" {
		return errf(400, "Choose a current employee.")
	}
	for _, m := range p.Members {
		if m.EmployeeID == e.ID {
			return errf(409, "%s is already on this project.", e.Name())
		}
	}
	if err := s.st.UpsertMember(c.ctx(), p.ID, e.ID, in.Role, in.Allocation); err != nil {
		return err
	}
	p, _ = s.st.GetProject(c.ctx(), p.ID)
	c.audit("project.member.add", "project", p.ID, p.Name, "Assigned "+e.Name()+" to "+p.Name, map[string]any{"role": in.Role, "allocation": in.Allocation})
	c.notifyTo("project.assigned", c.others([]recipient{empRcpt(e)}), func(recipient) tmail.Data {
		return tmail.Data{Project: p.Name, Role: in.Role, Link: s.workLink()}
	}, false)
	return c.JSON(200, toProject(p))
}

func (s *Server) updateProjectMember(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	var in memberInput
	if err := c.decode(&in); err != nil {
		return err
	}
	if err := in.clean(); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	eid := c.param("eid")
	if !onProject(&store.Project{Members: p.Members}, eid) {
		return errf(404, "That person is not on this project.")
	}
	if err := s.st.UpsertMember(c.ctx(), p.ID, eid, in.Role, in.Allocation); err != nil {
		return err
	}
	p, _ = s.st.GetProject(c.ctx(), p.ID)
	return c.JSON(200, toProject(p))
}

func (s *Server) removeProjectMember(c *call) error {
	if err := c.need("projects:manage"); err != nil {
		return err
	}
	p, err := c.project(c.param("id"))
	if err != nil {
		return err
	}
	e, err := s.st.GetEmployee(c.ctx(), c.param("eid"))
	if err != nil {
		return errf(404, "That person is not on this project.")
	}
	if err := s.st.RemoveMember(c.ctx(), p.ID, e.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errf(404, "That person is not on this project.")
		}
		return err
	}
	p, _ = s.st.GetProject(c.ctx(), p.ID)
	c.audit("project.member.remove", "project", p.ID, p.Name, "Removed "+e.Name()+" from "+p.Name, nil)
	c.notifyTo("project.unassigned", c.others([]recipient{empRcpt(e)}), func(recipient) tmail.Data { return tmail.Data{Project: p.Name} }, false)
	return c.JSON(200, toProject(p))
}
