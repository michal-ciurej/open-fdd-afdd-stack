# Context and Recordkeeping

This repo is intended to preserve engineering context in visible files, not in private chat memory alone.

## How OpenClaw saves context here

OpenClaw should record durable context in repo documentation when the context is:

- important for future clones of the repo
- important for repeatable testing or operations
- useful to future engineers, operators, or researchers
- more durable than a one-off chat summary

That means the preferred storage location is **versioned markdown in `docs/`**.

## What belongs in repo documentation

Examples of context worth saving:

- BACnet graph assumptions
- rule-verification plans
- overnight review procedure
- PR review heuristics
- known environment limitations
- lessons learned while validating Open-FDD
- future live-HVAC monitoring and optimization context

## What should not stay only in chat

These should not live only in chat history:

- validation strategy
- reasoning about the three operational states
- recurring review workflows
- how frontend/backend/log correlation is supposed to be checked
- how fake BACnet behavior maps to expected FDD outcomes

## Current context documents

Humans should start here:

- `docs/operational_states.md`
- `docs/overnight_review.md`
- `docs/bacnet_graph_context.md`
- `docs/ai_pr_review_playbook.md`
- `docs/testing_plan.md`
- `docs/context_and_recordkeeping.md`

## Why this exists

If this repo is cloned elsewhere, or if different agents/humans work on it later, the important engineering context should still be easy to find.

The goal is simple:

- save context in the repo
- make it visible to humans
- make it reusable by future agents
- reduce dependence on tribal knowledge
