Complete a correctness pass, then a separate security pass in the same
conversation before the final verdict. Do not delegate. On follow-ups, reassess affected trust boundaries and unresolved findings
against the new head, not just the fix diff.

### Correctness pass

Prioritize correctness and data preservation before lint and simplification.
Trace affected behavior from entry point through writes, callbacks and consumers,
including unchanged code, deletion dependencies and alternative writers. Grep
callers when a function's behavior changes; a new UI can expose an old writer's
limitations.

For risky mutations, state what must remain true: an unchanged save preserves
existing data, related stored representations stay consistent, and a stale form
cannot apply an operation that is no longer allowed. Check whether existing tests
exercise the relevant empty, deleted, stale or changed-state cases. When they do
not, attempt a focused local reproduction in the documented test runner. One good
test matters more than coverage totals; passing suites are not evidence for an
untested workflow. If execution is blocked, record the gap rather than treating
it as verified.

Read code in bounded sections. Recover clipped output before treating a file or
flow as reviewed.

Keep a short private working-evidence note connecting each high-risk flow to the
code inspected and the test or reproduction used. Distinguish verified behavior
from unchecked assumptions. Findings need a concrete input or sequence leading
to a wrong result, not a generic request for more tests. Assess realistic
likelihood separately from impact; an uncommon workflow can still cause serious
data loss.

### Security pass

Start with the trust boundary: who can do what before and after this PR?
Consider anonymous, unconfirmed, confirmed, cross-tenant and privileged users
where relevant. A new signup path, role, public endpoint or feature flag can
expose existing functionality; unchanged code is in scope when its reachability
or security assumptions change.

Trace each affected entry point through controllers, policies, jobs, storage
and external services. Check relevant authorization and tenant isolation,
session/token handling, injection, sensitive-data exposure and outbound-request
controls. For newly reachable resource-consuming operations, inspect email,
uploads, background jobs and paid API calls. Ask what one malicious account
can repeat, even when every request is individually valid.

Distinguish per-request limits from per-account, per-destination and aggregate
byte/cost limits. Check enforcement before the side effect, alternate endpoints,
retries, account creation and abandoned-resource cleanup. Authentication or
email confirmation does not make a user trusted; a signup IP limit does not
bound later actions, and a per-file size limit does not bound total storage.
Verify relevant application and documented deployment protections. Do not
assume an unseen gateway/provider limit exists or is sufficient.

Keep a short table in private local working evidence, not the report, with one
row per high-risk flow: actor, entry point, sensitive operation, existing
control, bypass attempt, result and unchecked assumptions. Include inspected
file/line references and test/repro evidence. Mark checks as execution-confirmed,
code-supported or unverified; explain non-applicable checks briefly rather than
inventing an attack surface. A passing happy-path test or scanner does not prove
resistance to abuse. Missing coverage is unverified, not safe.

Attempt bounded negative tests in the documented isolated runner when practical:
cross-user requests, repeated actions and limit-boundary cases. Use mocked mail
and paid services, small local uploads and disposable fixtures. Never send real
invitations, consume production storage or perform load attacks. If execution is
blocked, record the gap and use code-supported findings where justified. Do not
modify production code or add infrastructure to obtain a reproduction.

For each security finding, give a concrete attack path, prerequisites, checked
protections, practical impact and smallest fix. Assess likelihood separately
from impact; do not infer severity from category alone. Distinguish a new exposure
of old code from an unrelated pre-existing issue. Reconcile existing discussion
before the final verdict. Keep one concise report for both passes; no findings
is acceptable, but it is not a security guarantee.

## Review report format

Judge current PR readiness, not just whether findings are new. Include all
still-applicable actionable findings, labeled **new** or **previously reported**
with thread links. Deduplicate publication, not visibility of outstanding issues.
Keep fixed issues and accepted/deferred trade-offs in the thread assessment;
reopen them only with new evidence. Never equate “no new findings” with “no
outstanding defects.”

Write for non-native English speakers: use common words, short sentences and
one idea per sentence. Prefer active voice. Avoid idioms, slang, metaphors and
unnecessary jargon. Readers are developers with strong technical knowledge;
do not explain technical terms or acronyms. Keep code identifiers exact.
State each issue directly: what goes
wrong, when it happens, why it matters and how to fix it.

Keep the report short, plain-language and decision-focused. Omit empty sections
entirely, including their headings; never add “None” or “No confirmed findings”
placeholders. If there are no actionable findings, use only a brief summary
without a findings table. Include thread assessments only when relevant.
Do not include a Verification and limitations section or move its command logs,
test counts/seeds and skipped-check inventories elsewhere in the report. Keep
that detail in local working evidence. Mention a blocker in one sentence in the
summary only when it materially limits the readiness verdict. Still run the
required checks; shorter reporting does not mean less verification.

Use the following order for sections that have content:

1. **Summary:** scope, exact commits, readiness verdict and an outstanding-findings
   table with ID, priority, category, title and new/previously reported status.
   Sort the entire table by P1 through P5, most important first, across categories.
2. **Bugs / logic issues**
3. **Performance issues**
4. **Security issues**
5. **Refactoring suggestions:** concrete simplifications, deletions or reuse of
   existing code, with paths, benefit and smallest proposed change. Prioritize
   P1–P5 and sort most important first. Cross-reference related findings rather
   than counting the same defect twice. No speculative abstractions or style-only
   churn; omit this section when no useful refactoring is supported.
6. **Existing-thread assessment:** fixed, still applies, intentionally deferred,
   superseded or unresolved, with links. Still-applicable actionable findings
   must also appear in the summary and their category above.

Within each issue category, sort P1 through P5 and retain the summary's stable
finding IDs. Put each finding in one primary category; cross-reference overlaps.
For every finding give priority, file/line references, concrete trigger, impact,
evidence and smallest fix. Label evidence **execution-confirmed** or
**code-supported**; keep unverified concerns separate from established findings.
Keep each finding to a short paragraph or a few bullets; omit process narration,
repeated context and unnecessary detail. Omitted categories do not imply safety.

Priority is urgency, not confidence or category:

| Priority | Meaning |
| --- | --- |
| P1 — Critical | Immediate action; credible severe data loss, security exposure or widespread outage. Blocks merge/rollout. |
| P2 — High | Serious correctness, security or availability defect. Fix before merge/affected rollout. |
| P3 — Medium | Material but bounded impact or a practical workaround. Schedule a normal-priority fix. |
| P4 — Low | Minor impact, rare recoverable edge case or small measured inefficiency. Non-blocking. |
| P5 — Optional | Evidence-backed improvement with no demonstrated correctness/security failure. Nice to have. |

Assess likelihood, impact, existing protections and recovery before assigning
priority. Security findings are not automatically P1; refactoring is not
automatically urgent. Do not invent findings to populate categories or priorities.
For follow-ups, distinguish the incremental fix verdict from overall PR readiness;
label carried-forward findings that were not revalidated on the new head.
The final chat summary must mention outstanding high-priority findings, not just
new findings or passing tests.
