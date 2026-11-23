# Record architectural decisions as ADRs

Status: accepted · Decided: 2026-11-23 · Scope: repository

Until now, decisions lived in three places. `CLAUDE.md` held the hard rules. Each example's
`NOTES.md` held design ids, one line each. A plan document held the work in progress. None of them
said why a rule exists or what was rejected, so a later change could undo a deliberate choice
without knowing it was one.

From now on, a decision that is hard to reverse, surprising without context and the result of a
real trade-off is recorded in `docs/adr/`. `NOTES.md` keeps what it is good at: engine and library
behaviours, each with a minimal repro and the file that pins it, plus the short design ids the code
cites. A design id that carries a repository-level decision points to its ADR. `AGENTS.md` keeps the
rules and points to the ADR behind each one. A plan document is never the record of a decision.
Once its work lands, its decisions become ADRs.

ADRs 0002–0013 record the decisions examples 01 and 02 were built on, written after the fact. Each
names the commit, or the design ids, where the decision first appears. In those ADRs, **Considered
options** gives the reasons each alternative does not fit, as understood when the ADR was written.
It is not a history of what was debated.
