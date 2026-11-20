# pi-ipython

A pi extension that gives the model one tool, `ipython`: a persistent Python Kernel modelled on Unharnessed. Use the vocabulary in `GLOSSARY.md`.

## Docs

- **Scope**: what each release (v1–v4) includes and excludes: `docs/prd.md`
- **Build order** and pi extension integration points: `docs/plan.md`
- **Porting** or vendoring code from `references/`: `docs/agents/references.md`
- **Publishing**: prepare, verify, or recover an npm and GitHub release: `docs/agents/publishing.md`
- **Domain**: naming concepts or making architectural decisions (glossary, ADRs): `docs/agents/domain.md`
- **Issues**: specs and tickets live in GitHub Issues (`gh`): `docs/agents/issue-tracker.md`; labels: `docs/agents/triage-labels.md`

## Conventions

- Test through one seam: a real pi SDK session, a faux provider playing the model, and a real Kernel (vitest). The vendored runtime keeps its own pytest suite.
- Ported and vendored files keep their MIT copyright headers.
