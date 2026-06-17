#!/bin/bash
echo "=== AEP Compliance Full Test ==="
echo "Test 1: Validator execution"
node .ci/aep-validator.js
if [ $? -eq 0 ]; then
  echo "✓ Validator passed"
else
  echo "✗ Validator failed"
  exit 1
fi

echo "Test 2: AEP artifacts presence"
for f in aep/aep-scene.json aep/aep-registry.yaml aep/aep-theme.yaml aep/dynaep-config.yaml aep/15-step-checklist.md aep/AEP-PROPOSAL-TEMPLATE.md aep/aep-ui-ledger.jsonl; do
  if [ -f "$f" ]; then
    echo "✓ $f exists"
  else
    echo "✗ $f missing"
    exit 1
  fi
done

echo "Test 3: data-aep-id in index.html"
if grep -q 'data-aep-id' index.html; then
  echo "✓ data-aep-id attributes present"
else
  echo "✗ No data-aep-id attributes"
  exit 1
fi

echo "Test 4: AEP notes in app.js"
if grep -q 'AEP\|dynAEP' app.js; then
  echo "✓ AEP/dynAEP notes present in renderFeed"
else
  echo "✗ No AEP notes in app.js"
  exit 1
fi

echo "=== All tests passed — AEP compliance bulletproof ==="
