package server

import (
	"errors"
	"fmt"
	"net/url"

	tmail "techzaz.lk/tems-api/internal/mail"
	"techzaz.lk/tems-api/internal/store"
)

var (
	ticketStatusLabel = map[string]string{"open": "Open", "in_progress": "In progress", "in_review": "In review", "resolved": "Resolved", "closed": "Closed"}
	ticketPriorities  = map[string]string{"low": "Low", "medium": "Medium", "high": "High", "urgent": "Urgent"}
	ticketTypes       = map[string]string{"task": "Task", "bug": "Bug", "feature": "Feature", "support": "Support"}
)

func (s *Server) ticketLink(id string) string {
	return s.cfg.PublicURL + "/tickets/?id=" + url.QueryEscape(id)
}

// ticketAccess describes what the caller may do with a ticket.
type ticketAccess struct {
	view, manage, assignee, reporter bool
}

func (c *call) ticket(id string) (*store.Ticket, *store.Project, ticketAccess, error) {
	var acc ticketAccess
	t, err := c.s.st.GetTicket(c.ctx(), id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, acc, errf(404, "Ticket not found.")
	}
	if err != nil {
		return nil, nil, acc, err
	}
	p, err := c.s.st.GetProject(c.ctx(), t.ProjectID)
	if err != nil {
		return nil, nil, acc, err
	}
	me := c.myEmployeeID()
	acc.manage = c.P.Can("tickets:manage")
	acc.assignee = me != "" && t.AssigneeID != nil && *t.AssigneeID == me
	acc.reporter = t.ReporterID == c.P.ID
	acc.view = acc.manage || acc.assignee || acc.reporter || c.P.Can("tickets:view") || onProject(p, me)
	if !acc.view {
		return nil, nil, acc, errf(403, "You need the “tickets:view” permission to do that.")
	}
	return t, p, acc, nil
}

// assignee validates that the employee is on the project and returns them.
func (c *call) assignee(p *store.Project, id *string) (*store.Employee, error) {
	if id == nil || *id == "" {
		return nil, nil
	}
	if !onProject(p, *id) {
		return nil, errf(400, "Tickets can only be assigned to people on the project. Add them to the team first.")
	}
	return c.s.st.GetEmployee(c.ctx(), *id)
}

/* ---------- list / get ---------- */

func (s *Server) listTickets(c *call) error {
	f := store.TicketFilter{Search: c.query("search"), ProjectID: c.query("projectId"), Status: c.query("status"),
		AssigneeID: c.query("assigneeId"), Priority: c.query("priority")}
	f.Page, f.Size = c.paging(25)
	if c.query("mine") == "true" {
		me := c.myEmployeeID()
		if me == "" {
			return c.JSON(200, map[string]any{"items": []any{}, "total": 0})
		}
		f.AssigneeID = me
	} else if !c.P.Can("tickets:view") {
		// project members may see their own project's tickets
		if f.ProjectID == "" {
			return errf(403, "You need the “tickets:view” permission to do that.")
		}
		if _, err := c.project(f.ProjectID); err != nil {
			return err
		}
	}
	items, total, err := s.st.ListTickets(c.ctx(), f)
	if err != nil {
		return err
	}
	return c.JSON(200, map[string]any{"items": items, "total": total})
}

func (s *Server) getTicket(c *call) error {
	t, _, _, err := c.ticket(c.param("id"))
	if err != nil {
		return err
	}
	return c.JSON(200, t)
}

/* ---------- create ---------- */

func (s *Server) createTicket(c *call) error {
	var in struct {
		ProjectID   string  `json:"projectId"`
		Title       string  `json:"title"`
		Description string  `json:"description"`
		Type        string  `json:"type"`
		Priority    string  `json:"priority"`
		AssigneeID  *string `json:"assigneeId"`
		DueDate     string  `json:"dueDate"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	p, err := c.project(in.ProjectID)
	if err != nil {
		return err
	}
	if !c.P.Can("tickets:create") && !c.P.Can("tickets:manage") && !onProject(p, c.myEmployeeID()) {
		return errf(403, "You need the “tickets:create” permission to do that.")
	}
	if p.Status == "completed" || p.Status == "cancelled" {
		return errf(409, "This project is %s. Reopen it to raise tickets.", projectStatuses[p.Status])
	}
	t := &store.Ticket{ProjectID: p.ID, Title: clip(in.Title, 200), Description: clip(in.Description, 20000), Type: in.Type,
		Priority: in.Priority, DueDate: in.DueDate, ReporterID: c.P.ID, Reporter: c.P.Name}
	if t.Title == "" {
		return errf(400, "Give the ticket a title.")
	}
	if ticketTypes[t.Type] == "" {
		t.Type = "task"
	}
	if ticketPriorities[t.Priority] == "" {
		t.Priority = "medium"
	}
	if !validDate(t.DueDate) {
		return errf(400, "Dates must be in the form YYYY-MM-DD.")
	}
	if in.AssigneeID != nil && *in.AssigneeID != "" && !c.P.Can("tickets:manage") && !c.P.Can("projects:manage") {
		return errf(403, "You need the “tickets:manage” permission to assign tickets.")
	}
	who, err := c.assignee(p, in.AssigneeID)
	if err != nil {
		return err
	}
	if who != nil {
		t.AssigneeID = &who.ID
	}
	id, err := s.st.CreateTicket(c.ctx(), t)
	if err != nil {
		return err
	}
	t, _ = s.st.GetTicket(c.ctx(), id)
	c.audit("ticket.create", "ticket", t.ID, t.Ref, "Raised "+t.Ref+" · "+t.Title, map[string]any{"project": p.Name, "priority": t.Priority})
	if who != nil {
		c.notifyAssigned(t, p, who)
	}
	return c.JSON(201, t)
}

func (c *call) notifyAssigned(t *store.Ticket, p *store.Project, who *store.Employee) {
	c.notifyTo("ticket.assigned", c.others([]recipient{empRcpt(who)}), func(recipient) tmail.Data {
		ch := []string{"Priority: " + ticketPriorities[t.Priority], "Type: " + ticketTypes[t.Type]}
		if t.DueDate != "" {
			ch = append(ch, "Due: "+t.DueDate)
		}
		return tmail.Data{Item: t.Ref + " · " + t.Title, Project: p.Name, Changes: ch, Link: c.s.ticketLink(t.ID)}
	}, false)
}

// watchers are the people told about changes to a ticket: its assignee and reporter.
func (c *call) watchers(t *store.Ticket) []recipient {
	var rs []recipient
	if t.AssigneeID != nil {
		if e, err := c.s.st.GetEmployee(c.ctx(), *t.AssigneeID); err == nil {
			rs = append(rs, empRcpt(e))
		}
	}
	if sn, err := c.snap(); err == nil {
		if u := sn.ByID[t.ReporterID]; u != nil {
			rs = append(rs, userRcpt(u))
		}
	}
	return c.others(rs)
}

/* ---------- update ---------- */

func (s *Server) updateTicket(c *call) error {
	var in struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Type        *string `json:"type"`
		Priority    *string `json:"priority"`
		Status      *string `json:"status"`
		AssigneeID  *string `json:"assigneeId"`
		DueDate     *string `json:"dueDate"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	t, p, acc, err := c.ticket(c.param("id"))
	if err != nil {
		return err
	}
	// Assignees and reporters move their tickets along and reporters can reword
	// them; priority, due date and assignment need tickets:manage.
	if !acc.manage {
		wording := in.Title != nil || in.Description != nil || in.Type != nil
		planning := in.Priority != nil || in.DueDate != nil || in.AssigneeID != nil
		if planning || (wording && !acc.reporter) || (in.Status != nil && !acc.assignee && !acc.reporter) {
			return errf(403, "You need the “tickets:manage” permission to do that.")
		}
	}
	before := *t
	var changes []string
	if in.Title != nil {
		if v := clip(*in.Title, 200); v != "" && v != t.Title {
			t.Title = v
			changes = append(changes, "Title changed")
		}
	}
	if in.Description != nil && clip(*in.Description, 20000) != t.Description {
		t.Description = clip(*in.Description, 20000)
		changes = append(changes, "Description updated")
	}
	if in.Type != nil && ticketTypes[*in.Type] != "" && *in.Type != t.Type {
		changes = append(changes, "Type: "+ticketTypes[t.Type]+" → "+ticketTypes[*in.Type])
		t.Type = *in.Type
	}
	if in.Priority != nil && ticketPriorities[*in.Priority] != "" && *in.Priority != t.Priority {
		changes = append(changes, "Priority: "+ticketPriorities[t.Priority]+" → "+ticketPriorities[*in.Priority])
		t.Priority = *in.Priority
	}
	if in.Status != nil && *in.Status != t.Status {
		if ticketStatusLabel[*in.Status] == "" {
			return errf(400, "Unknown status.")
		}
		changes = append(changes, "Status: "+ticketStatusLabel[t.Status]+" → "+ticketStatusLabel[*in.Status])
		t.Status = *in.Status
	}
	if in.DueDate != nil && *in.DueDate != t.DueDate {
		if !validDate(*in.DueDate) {
			return errf(400, "Dates must be in the form YYYY-MM-DD.")
		}
		changes = append(changes, "Due: "+orDash(t.DueDate)+" → "+orDash(*in.DueDate))
		t.DueDate = *in.DueDate
	}
	var newAssignee *store.Employee
	if in.AssigneeID != nil {
		cur := ""
		if t.AssigneeID != nil {
			cur = *t.AssigneeID
		}
		if *in.AssigneeID != cur {
			newAssignee, err = c.assignee(p, in.AssigneeID)
			if err != nil {
				return err
			}
			if newAssignee != nil {
				t.AssigneeID = &newAssignee.ID
				changes = append(changes, "Assigned to "+newAssignee.Name())
			} else {
				t.AssigneeID = nil
				changes = append(changes, "Unassigned")
			}
		}
	}
	if len(changes) == 0 {
		return c.JSON(200, t)
	}
	if err := s.st.UpdateTicket(c.ctx(), t); err != nil {
		return err
	}
	_, actor := c.actor()
	for _, ch := range changes {
		_ = s.st.AddComment(c.ctx(), &store.TicketComment{TicketID: t.ID, Author: actor, AuthorID: c.P.ID, Body: ch, System: true})
	}
	t, _ = s.st.GetTicket(c.ctx(), t.ID)
	c.audit("ticket.update", "ticket", t.ID, t.Ref, fmt.Sprintf("Updated %s: %s", t.Ref, changes[0]), map[string]any{"changes": changes})

	// the new assignee gets an assignment email; everyone else watching gets the change summary
	if newAssignee != nil {
		c.notifyAssigned(t, p, newAssignee)
	}
	var rest []recipient
	for _, r := range c.watchers(&before) {
		if newAssignee == nil || r.Email != newAssignee.Email {
			rest = append(rest, r)
		}
	}
	c.notifyTo("ticket.updated", rest, func(recipient) tmail.Data {
		return tmail.Data{Item: t.Ref + " · " + t.Title, Project: p.Name, Changes: changes, Link: s.ticketLink(t.ID)}
	}, false)
	return c.JSON(200, t)
}

func (s *Server) deleteTicket(c *call) error {
	if err := c.need("tickets:manage"); err != nil {
		return err
	}
	t, _, _, err := c.ticket(c.param("id"))
	if err != nil {
		return err
	}
	if err := s.st.DeleteTicket(c.ctx(), t.ID); err != nil {
		return err
	}
	c.audit("ticket.delete", "ticket", t.ID, t.Ref, "Deleted "+t.Ref+" · "+t.Title, nil)
	return c.NoContent()
}

/* ---------- comments ---------- */

func (s *Server) ticketComments(c *call) error {
	t, _, _, err := c.ticket(c.param("id"))
	if err != nil {
		return err
	}
	cs, err := s.st.Comments(c.ctx(), t.ID)
	if err != nil {
		return err
	}
	return c.JSON(200, cs)
}

func (s *Server) addTicketComment(c *call) error {
	var in struct {
		Body string `json:"body"`
	}
	if err := c.decode(&in); err != nil {
		return err
	}
	t, p, _, err := c.ticket(c.param("id"))
	if err != nil {
		return err
	}
	body := clip(in.Body, 10000)
	if body == "" {
		return errf(400, "Write a comment.")
	}
	cm := &store.TicketComment{TicketID: t.ID, Author: c.P.Name, AuthorID: c.P.ID, Body: body}
	if err := s.st.AddComment(c.ctx(), cm); err != nil {
		return err
	}
	c.notifyTo("ticket.commented", c.watchers(t), func(recipient) tmail.Data {
		return tmail.Data{Item: t.Ref + " · " + t.Title, Project: p.Name, Note: body, Link: s.ticketLink(t.ID)}
	}, false)
	return c.JSON(201, cm)
}
