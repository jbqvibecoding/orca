// Workflow documents that ship with Orca.
//
// Phase instruction text is derived from agtx (https://github.com/jbqvibecoding/agtx),
// `plugins/agtx/skills/*.md` and `plugins/agtx-terse/skills/*/SKILL.md`. See
// THIRD_PARTY_NOTICES.md for the licence and the list of modifications.
//
// TS module rather than `extraResources`: these are small data documents, a
// bundled file outside the asar has to be located at runtime and cannot be
// typechecked, and P1b already paid for that lesson with the delegate sidecar.

const STANDARD = `
name: standard
description: Research, plan, execute, and review with an artifact at each checkpoint.
cycle_to: planning
phases:
  research:
    artifact: .orca/research.md
    instruction: |
      You are in the RESEARCH phase. This is a read-only exploration.

      1. Explore the codebase to find the relevant files, patterns, and architecture.
      2. Identify dependencies, related code, and where the complexity sits.
      3. Assess scope: simple change, moderate refactor, or major undertaking.

      Write your findings to .orca/research.md with these sections:

      ## Relevant Files
      Key files and their roles - what exists, what needs changing.

      ## Architecture
      How the relevant parts fit together.

      ## Complexity
      Your scope assessment.

      ## Open Questions
      What needs clarification before planning can begin.

      Do NOT modify any source file, create a branch, or start implementing.
      Writing .orca/research.md completes this phase.
  planning:
    artifact: .orca/plan.md
    accepts: []
    instruction: |
      You are in the PLANNING phase. Do not change any source file yet.

      1. If .orca/research.md exists, read it for the prior analysis.
      2. Explore the codebase for the files, patterns, and architecture this touches.
      3. Identify every file to create or modify.
      4. Write a detailed implementation plan.

      Write the plan to .orca/plan.md, relative to your current working directory,
      with these sections:

      ## Analysis
      What you found - relevant files, patterns, dependencies.

      ## Plan
      Step by step: files to modify, approach, order of changes.

      ## Risks
      Edge cases, breaking changes, areas needing extra care.

      Writing .orca/plan.md completes this phase. Do not start implementing.
  running:
    artifact: .orca/execute.md
    accepts: [typecheck, test]
    instruction: |
      You are in the EXECUTION phase.

      1. Read .orca/plan.md - it holds the approved plan and its context.
      2. Implement the changes.
      3. Run the relevant tests and fix what they surface.

      Write a summary to .orca/execute.md with these sections:

      ## Changes
      Which files changed and what changed in each.

      ## Testing
      How you verified the work - commands run, results, manual checks.

      Writing .orca/execute.md completes this phase. Do not start work beyond
      the plan; raise anything the plan did not anticipate instead.
  review:
    artifact: .orca/review.md
    accepts: [typecheck, test, lint]
    instruction: |
      You are in the REVIEW phase.

      1. Review every change from the execution phase. Use \`git diff HEAD\` for
         staged and unstaged work, and
         \`git log --oneline $(git merge-base HEAD origin/HEAD)..HEAD\` for your
         own commits. Do NOT diff against main or origin/main - those carry
         unrelated upstream history.
      2. Check correctness and edge cases, error handling, consistency with the
         surrounding code, test coverage, and security.
      3. Fix what you find.

      Write the review to .orca/review.md with these sections:

      ## Review
      What looks good, what you fixed, what still concerns you.

      ## Status
      READY, or NEEDS_WORK with the remaining issues.

      Writing .orca/review.md completes this phase.
`

const STANDARD_TERSE = `
name: standard-terse
description: The standard phases with compressed output, for token-tight runs.
cycle_to: planning
phases:
  research:
    artifact: .orca/research.md
    instruction: |
      You are in the RESEARCH phase. Read-only: change no source file.

      Explore the codebase, then write .orca/research.md with four short
      sections - Relevant Files, Architecture, Complexity, Open Questions.
      Bullet points, no prose padding, no restating the task back.
      Writing the file completes this phase.
  planning:
    artifact: .orca/plan.md
    instruction: |
      You are in the PLANNING phase. Change no source file yet.

      Read .orca/research.md if it exists. Write .orca/plan.md with three short
      sections - Analysis, Plan (ordered steps naming each file), Risks.
      Bullet points only. Writing the file completes this phase.
  running:
    artifact: .orca/execute.md
    accepts: [typecheck, test]
    instruction: |
      You are in the EXECUTION phase.

      Implement .orca/plan.md, run the relevant tests, fix what they surface.
      Write .orca/execute.md with two short sections - Changes (file: what
      changed) and Testing (command: result). Writing the file completes this
      phase. Do not go beyond the plan.
  review:
    artifact: .orca/review.md
    accepts: [typecheck, test, lint]
    instruction: |
      You are in the REVIEW phase.

      Review your own diff (\`git diff HEAD\`, and your commits via
      \`git merge-base HEAD origin/HEAD\`; never diff against main). Check
      correctness, edge cases, error handling, tests, security. Fix what you
      find. Write .orca/review.md with Review (findings) and Status
      (READY or NEEDS_WORK plus what is left). Writing the file completes this
      phase.
`

/** Document name -> YAML source. Parsed on demand so a malformed edit fails loudly in tests. */
export const BUILTIN_WORKFLOW_DOCUMENTS: Readonly<Record<string, string>> = {
  standard: STANDARD,
  'standard-terse': STANDARD_TERSE
}

export const DEFAULT_WORKFLOW_NAME = 'standard'
