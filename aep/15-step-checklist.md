# SayIt AEP 15-Step Evaluation Checklist (for use in prompts and CI)

Always-mode steps (run on every proposal):
1. Ring capability check
2. Covenant evaluation
3. Rego/policy check
4. Budget/limit
5. Content scanner: PII/Secrets
6. Content scanner: Injection/Jailbreak
7. Content scanner: Toxicity
8. Structural validation (z-band/parent)
9. Delegated events only
10. Sanitization path verified

Active-mode (short-circuit on violation):
11-15. Additional scanners + recovery

Reference: ~/aep/aep-main/harness for full details.
