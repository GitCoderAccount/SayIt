# Pilot Governed AEP Edit Example

## Step 1: Read AEP Artifacts
cat aep/aep-scene.json aep/aep-registry.yaml aep/aep-theme.yaml

## Step 2: Produce AEP Proposal
Affected IDs: CN-XXXX (new post row)
Invariants: Delegated events, sanitization via utils.safe, z-band compliance

## Step 3: Implement with Validation
Use the proposal template before editing.

## Step 4: Post-Edit
Bump SW_CACHE_VER, run validator, log to ledger.

This is the template for the first governed pilot edit.
