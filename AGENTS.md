# AGENTS.md — SayIt (AEP-Governed)

**AEP (~/aep/aep-main) is the MANDATORY governance layer for every new coding or work session.** Zero-trust UI. No hallucinations. All proposals validated before execution.

This file is the single source of truth for session startup, UI discipline, delegation, anti-stub, and prompt templates. It integrates with SayIt's existing `.grok/agents/sayit-coder.md`, `.ci/` gates, and static PWA constraints. Root `/home/user/CLAUDE.md` multi-agent director/worker model applies on top.

## 1. Fresh Session Startup Template (MANDATORY — First Action)

**Every new session (Grok Build, Claude Code, direct, subagent, etc.) starts here. No exceptions. No "I'll do it later".**

```bash
cd /home/user/SayIt
export AEP_ROOT=/home/user/aep/aep-main
export PYTHONPATH=/home/user/aep/aep-main/dynAEP/sdk/python

# Verify dynAEP Python SDK available (optional but recommended)
python3 -c "
import sys
sys.path.insert(0, '/home/user/aep/aep-main/dynAEP/sdk/python')
import dynaep
print('dynAEP SDK loaded:', dynaep.__file__)
" 2>/dev/null || echo "dynAEP Python SDK note: import may require full setup; path is set."

# Load canonical AEP governance artifacts (read in full at start of session)
# Structure (IDs, parents, z-bands, topology)
cat $AEP_ROOT/config/aep-scene.json | head -100
# Behaviour (constraints, events, forbidden, skin_bindings, templates)
cat $AEP_ROOT/config/aep-registry.yaml | head -150
# Skin (resolve only via skin_binding; never hardcode visuals)
cat $AEP_ROOT/config/aep-theme.yaml | head -80

# Anti-stub + policies (read these)
cat $AEP_ROOT/harness/aep-2.75-agent-harness/protocols/AEP-2.6-Anti-Stub-Protocol.md
cat $AEP_ROOT/policies/coding-agent.policy.yaml
cat $AEP_ROOT/policies/multi-agent.policy.yaml 2>/dev/null || true

# SayIt local rules
cat .grok/agents/sayit-coder.md
```

**Session declaration (state in first response):**
"AEP session initialized. Using coding-agent policy (Ring 2 default), dynAEP lattice/temporal, anti-stub ASV, central scene/registry/theme as source of truth. SayIt constraints active (static files, core.js→cache.js→app.js order, SW_CACHE_VER bump, .ci/ extract+lint+regression). Lattice memory engaged. Ready for governed work."

If MCP servers are connected, call `lattice_query` / `aepassist` status early.

**Local AEP artifacts (recommended but not blocking):** If SayIt grows `aep/` (per FORMAL_CODE_AUDIT_REPORT.md), prefer project-local but cross-validate against central $AEP_ROOT configs for prefix/z/skin consistency.

## 2. AEP MCP Integration Notes

- **AEP main MCP** (scene/registry/theme, element ops, validation): `node $AEP_ROOT/dist/cli.js serve` (or `npx aep assist` flows). Add in Claude: `claude mcp add aep -- node /home/user/aep/aep-main/dist/cli.js serve`.
- **dynAEP MCP** (Action Lattice for events, real-time governance, temporal authority): Run via `npx dynaep mcp-serve` or `node $AEP_ROOT/dynAEP/mcp-server` (transports: stdio/SSE/WS). 7 native tools (lattice passes every call):
  - `lattice_query`, `lattice_validate`
  - `agent_register`, `agent_discover`
  - `event_submit`
  - `temporal_query` (NEVER use Date.now() — authoritative bridge clock + drift/causal/forecast)
  - `causal_trace`
- All tool calls filtered by lattice (trust floor, partial order, constraints). Prefer these over manual ID guessing.
- Grok Build: Configure MCP servers in `.grok` / config if supported; surface via tools.
- In prompts: "If AEP/dynAEP MCP tools available, use them for ID minting, validation, temporal stamps, lattice checks before any structural or UI proposal."

See dynAEP README.md, mcp-server/index.ts, CONFIG.md, and AEP-main-skill/SKILL.md for full details.

## 3. Rules for AEP Scene/Registry/Theme Validation Before ANY UI Changes (Zero-Trust)

**Hard rule:** No edit to index.html, app.js (or core render paths), CSS, new elements, modals, feed, popups, themes, or any pixel-affecting code until validation passes and is explicitly reported.

**Process (output before code):**
1. Read current central (or local) aep-scene.json + aep-registry.yaml + aep-theme.yaml (or query via MCP/python).
2. Propose only using **AEP prefix convention**:
   - SH- (shell 0-9), PN-/NV- (panels/nav 10-19), CP-/FM-/IC- (comp/form/icon 20-29), CZ-/CN- (cell zone/node 30-39), TB- (toolbar 40-49), WD- (widget 50-59), OV- (overlay 60-69), MD-/DD- (modal/dropdown 70-79), TT- (tooltip 80-89).
3. For every element: unique ID, valid parent (topological containment), z strictly inside band for prefix, skin_binding declared in registry entry + resolves in theme.component_styles (no hard-coded colors/sizes in JS/CSS for governed elements).
4. Dynamic/repeating items: governed by CN-TEMPLATE-* (validate the mould).
5. Forbidden (enforced via Rego in registry + validators): z inversions (MD below CZ, TT below MD), orphans, unresolved skin_bindings, non-delegated handlers (SayIt rule: delegated only), injection/unsafe sinks (use core.js `utils.safe` / `safeUrl`).
6. SayIt mapping examples (enforce discipline even pre-local artifacts): main feed ≈ CZ-00001 + CN-* rows (virtualized), modals ≈ MD-*, composer/buttons ≈ CP-*, side panels ≈ PN-/NV-*. Respect existing virtualization, CSP, delegation, and `innerHTML` discipline via safe wrappers.
7. Output explicit block:
   ```
   ## AEP Proposal (validated)
   - Affected IDs: CZ-00001, CN-TEMPLATE-01, MD-00042
   - Parents/z/skin: ... (passed checks vs scene/registry/theme)
   - SayIt invariants: delegated events, utils.safe at sinks, virtualizer height map preserved, no SW assets changed (or bump planned)
   - Registry constraints: ...
   - Tool/MCP validation: lattice_query(...) returned ...
   ```
8. Only then implement via precise edits. Post-edit: run `.ci/` gates + bump `SW_CACHE_VER` (app.js) for any of the 5 core assets (index.html, app.js, core.js, cache.js, boot.js).

Changing one AEP layer never requires touching the others. Violations = hard reject or recovery loop (max retries per policy).

This makes SayIt's strong runtime (CSP, sanitizeTxs, delegation, virtualizer) into pre-proposal machine-enforced governance.

## 4. Integration with Coding-Delegation-Protocol

- Policies define `agent:delegate` (multi-agent.policy.yaml) and `agent:spawn` under trust tiers.
- Patterns (AEP README + harness + aep-comm): Supervisor (parent spawns workers, inherits covenant subset + monotonic ring/trust reduction), debate, dynamic task delegation via identity cards + resolver.
- Director (main session, per root CLAUDE.md) plans/audits/reviews; workers (subagents) implement under coding-agent policy. Director greps diffs, re-runs gates, never trusts worker narratives on mandatory items (SW_CACHE_VER, AEP validation, anti-stub self-audit).
- When delegating: declare scope, use `agent:delegate`, cross-verify outputs via lattice or evidence ledger. SayIt director/worker split stays intact.
- Reference: $AEP_ROOT/src/aep-comm/delegate/resolver.ts, harness, policies/, AEP-main-skill for multi-agent.

## 5. Anti-Stub Protocol (ASV) Adherence (MANDATORY)

Read and follow $AEP_ROOT/harness/aep-2.75-agent-harness/protocols/AEP-2.6-Anti-Stub-Protocol.md on every startup.

- **HARD (block commit/done)**: `raise "not implemented"`, `raise "TODO"`, empty public modules, delegation to known stubs.
- **SOFT (warn + review)**: Public fns with all `_` params returning literals (`:ok`, `nil`, `{:error, :not_implemented}`), pure pass-throughs, facade where doc >> body, test stubs only checking :ok.
- **Before claiming any task "complete", "done", or "verified"**:
  - Self-audit **every** created/modified file (AST preferred; include grep outputs in report).
  - Function count matches spec.
  - Zero hard/soft stub patterns in public surface.
  - Test assertions >= public functions (or equivalent coverage).
  - Include exact command outputs in final response.
- Exemptions only for documented intentional debt in a stubs registry. No "it works for now" facades.
- Enforce in .ci/ where possible + pre-commit spirit. SayIt: full correct implementations that preserve protocol invariants, privacy, CSP, and on-chain semantics.

## 6. Prompt Templates

### For Grok Build (add to system, persona, or sayit-coder context; agents_md: true loads this AGENTS.md)

```
## MANDATORY AEP ZERO-TRUST GOVERNANCE (dynAEP + SayIt)
Fresh session: ALWAYS run the exact Startup Template from /home/user/SayIt/AGENTS.md §1 (PYTHONPATH dynAEP/python, cat central scene/registry/theme + anti-stub + coding-agent + sayit-coder.md). Declare AEP session initialized.

UI/structural changes (any render, DOM, CSS, modal, feed, element): 
- Read aep-scene.json + aep-registry.yaml + aep-theme.yaml first (or MCP lattice_query).
- Every proposal MUST map to registered prefix/ID + parent + exact z-band + skin_binding.
- Validate: no orphans, z-band compliance and hierarchy, skin resolves, delegated events only, SayIt-safe sinks (utils.safe/safeUrl), virtualizer invariants, no CSP violations.
- Output "AEP Proposal:" block (IDs, checks, SayIt mappings, tool results) BEFORE any edit.
- Reference exact file:line numbers. Bump SW_CACHE_VER (app.js) on core 5 assets + run .ci/extract + lint + regression.

Anti-stub: Read AEP-2.6-Anti-Stub-Protocol.md. Full impls only. Self-audit (grep/AST for stubs) + include results before "done".

Coding-delegation: Use supervisor/delegate patterns under coding-agent policy (Ring 2). Director verifies all worker claims/diffs/gates.

MCP: Use dynAEP/AEP tools (lattice_*, temporal_query, etc.) when available for validation/clock instead of guessing or Date.now().

Recovery on soft violation; hard reject. Lattice memory: recall prior rejections/attractors for SayIt UI patterns.

SayIt constraints (from .grok/agents/sayit-coder.md): static no-build, load order core→cache→app, SW_CACHE_VER, .ci/ workflow, on-chain protocol fidelity, privacy/CSP.

Report file:line + AEP conformance + verification steps in every response.
```

### For Claude Code (add to CLAUDE.md project memory, or per-session prompt + MCP)

```
Every SayIt session starts with the AEP Fresh Session Startup Template (AGENTS.md §1). Set PYTHONPATH. Read central AEP scene/registry/theme + anti-stub protocol + coding-agent policy + local .grok/agents/sayit-coder.md.

Use AEP/dynAEP MCP tools (add via claude mcp add aep -- node /home/user/aep/aep-main/dist/cli.js serve; similar for dynAEP) for all ID, lattice, temporal, validation queries.

Before any UI/frontend structural change: explicit AEP validation against scene/registry/theme per AGENTS.md §3. Output AEP Proposal block. Never hallucinate IDs, z, parents, or visuals.

Adhere strictly to anti-stub (full impl + self-audit before done). Use coding-delegation for sub-work (director/worker per root CLAUDE.md).

Follow SayIt rules: SW_CACHE_VER bump, .ci/ gates, static discipline.

Reference AGENTS.md for full templates, rules, and MCP startup.
```

## 7. Additional SayIt + Workflow Notes

- Post any core change: node .ci/extract-inline-script.js; appropriate lint/test/smoke/regression. Nightly-style live checks for deploys.
- Evidence/ledgers: Prefer when harness/MCP enabled.
- Multi-agent: Director (you) owns verification of mandatory AEP/anti-stub/SW_VER items via actual diffs + re-execution. Workers stop after commit.
- When in doubt: default to strictest (AEP strict preset mindset, hard scanners, recovery max low).
- Biosecurity / harness registration: Follow AEP harness when using full aepassist flows.

## References (read on startup as needed)

- AEP: $AEP_ROOT/README.md, AEP-main-skill/SKILL.md, config/*, policies/*, docs/ (OWASP-MAPPING.md etc.), harness/aep-2.75-agent-harness/
- dynAEP: $AEP_ROOT/dynAEP/README.md, CONFIG.md, SPEC.md, mcp-server/, sdk/python/
- SayIt: README.md, .grok/agents/sayit-coder.md, FORMAL_CODE_AUDIT_REPORT.md (AEP recs), AUDIT.md, .ci/, core.js (utils/sanitize), app.js (render/SW_VER)
- Root: /home/user/CLAUDE.md (director/worker, verification split)

**AEP is not optional.** It is the front gate. Follow it to ship hallucination-free, zero-trust UI for SayIt.

*End of AGENTS.md*
## AEP Compliance Artifacts (Added 2026-06-17)
- aep/aep-scene.json: Structure mappings for feed (CZ-00001), virtualized rows (CN-*), modals (MD-*)
- aep/aep-registry.yaml: Behaviour constraints (delegated events, sanitization, forbidden patterns)
- aep/aep-theme.yaml: Skin bindings

All new UI changes must start with reading these artifacts and producing an AEP Proposal validated against them.

## Pre-Edit AEP Validation Workflow (Mandatory for All Changes)
1. Read aep/aep-scene.json, aep-registry.yaml, aep-theme.yaml
2. Produce "AEP Proposal" block before any edit:
   - Affected IDs/prefixes
   - Invariants proof (z-band, parent, delegated events, sanitization)
   - Skin binding if visual
3. Validate proposal against registry scanners and constraints
4. Only then implement
5. Recovery loop on soft violation (max 2 retries)
6. Post-edit: bump SW_CACHE_VER, run .ci/ gates, log to lattice memory (aep-ui-ledger.jsonl)

All Grok Build / Claude / Hermes coding sessions must follow this exactly.
## dynAEP / Lattice Integration (Added for Full Compliance)
- Config: aep/dynaep-config.yaml
- Usage: Load via PYTHONPATH to dynAEP/sdk/python
- Events to instrument: renderFeed, modal open/close, post publish
- Commands: event_submit for key UI actions + temporal stamps
- MCP: Use dynaep mcp-serve or integrate via AEP MCP

## CI Enforcement (Added)
- .ci/aep-validator.js : Basic declarative compliance checker
- Run via npm test or pre-commit for AEP gate

## Code-Level AEP Implementation (Started)
- data-aep-id attributes added to key elements in index.html (CZ-00001 feed, MD-* modals, PN-*, etc.)
- Next: Extend to app.js render paths and dynAEP event_submit instrumentation

## Lattice Memory Ledger
- aep/aep-ui-ledger.jsonl : For logging AEP proposals, validations, and rejections (dynAEP style)
