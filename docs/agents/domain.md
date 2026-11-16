# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring

- Read the root `GLOSSARY.md`, if it exists.
- Read ADRs in `docs/adr/` that touch the area you're about to work in.

If these don't exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This is a single-context repo:

```
/
├── GLOSSARY.md
└── docs/adr/
```

## Use the glossary's vocabulary

When naming a domain concept, use the term defined in `GLOSSARY.md`. If a concept isn't there, reconsider whether the project uses it or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
