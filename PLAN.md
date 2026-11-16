# Gemini subagents for Claude Code: plan

The goal is for Gemini models, mainly Hydrogen as a cheaper stand-in for Haiku, to be offered next to Claude subagents. Claude picks Gemini itself for routine work; with `askOnSpawn` on, the user picks Claude or Gemini each time a subagent starts.

## How it works

- **agy** is Google's Antigravity CLI, a terminal coding agent. It is separate from the Antigravity IDE.
- It signs in with the Google AI Pro plan, so it needs no API key and no proxy.
- `agy -p "<task>" --model <slug> --output-format json` runs one task headless and returns a JSON envelope: `response`, `error`, `status`, `usage`.
- Claude Code can't use Gemini as its own model. Instead, a **mod** hands tasks to agy.

## Status (2026-11-14)

- [x] Mod `GeminiClaude` written; it validates and type-checks.
- [x] agy 1.5.9 installed and signed in; smoke test passed (hydrogen-low)
- [x] Mod tried against real agy output (2026-11-14): the `agy models` parser against the real table (18 slugs, the "Fetching available models..." line skipped), and the success and error JSON envelopes
- [x] Mod moved somewhere every session loads it (see step 4)
- [x] Parallel runs tried live (2026-11-15): three tasks in one call all started in the same second and finished 11, 35 and 49 seconds later

## The mod

The source is in `GeminiClaude/`. It is installed from this folder as the marketplace plugin `GeminiClaude@GeminiClaude`, so every session (CLI and desktop) loads it; run `/reload-plugins` after edits. It has these files:

- `.claude-plugin/plugin.json`: the manifest, plus two options, `askOnSpawn` and `autoHaiku` (both default off). With `autoHaiku` on, the arne judge reads each main-thread Agent brief and a tier-S one runs on Haiku.
- `hooks/hooks.json`: points to `./register.tsx`.
- `hooks/register.tsx`: all the logic.
- `types/index.d.ts`: the state contract for the band's values.

What it does:

1. **At session start** it runs `agy models` and registers the tool `mcp__GeminiClaude__delegate`. The tool's schema is always in the prompt and lists the models, and its description tells Claude to consider Gemini whenever it would spawn a subagent.
2. **Before a main-thread Agent call** it asks "Claude (type) or Gemini model?", but only when `askOnSpawn` is turned on. By default Claude chooses Gemini itself, guided by a section the mod adds to the system prompt (`prompt.compose`). When asking, up to 3 models are offered, Hydrogen and Argon first, and you can type any other slug. If you pick Gemini, agy runs the task and its reply comes back as the subagent's result.
3. **Band above the prompt:** shows "ready · N models", the running run, or the last run's model, label, seconds, tokens and ✓/✗, with a Hide button; a new run un-hides it.
4. **Parallel runs:** the tool takes a `tasks` list of 1 to 5 tasks and runs them at once, one agy process each; the replies come back together, each under its task's heading. While several are in flight the band shows "N agents" and one row per agent (label and model); a finished one drops off.
5. **Delegate checks:** the tool refuses a model slug not in `agy models` (in any task), an empty or over-long `tasks` list, and a brief over 30,000 characters.
6. **arne routing:** a task with no `model` (or `"auto"`) is judged by arne's Haiku judge prompt (copied from `arne/hooks/backends.ts`, kept equal by hand). Tier S goes to Hydrogen, M and L to Argon, at the judge's effort (L always high); no verdict means Argon medium. The reply starts with `[arne: <slug>, <tier> · <effort> · <reason>]`. An explicit slug skips the judge.
7. **Live view:** the band shows the tool each agent is on, tool and thinking counts; `/gemini` or the band's Details button opens a side pane with every agent's tool-call history, tokens and thinking (finished runs keep the last 25 steps).
8. **Skipped:** subagents started by other subagents, `fork`, `web-fetch`, and any session where agy is missing. In that last case it only shows the status line "gemini: agy not found or signed out".

## Steps

1. **Install agy.** The user runs this (PowerShell):
   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```
   It installs to `%LOCALAPPDATA%\agy\bin`. Then run `agy` once and sign in with the Pro account.
2. **Find the model slugs.** Run `agy models` and note the real Hydrogen slug. The docs show names like `gemini-4-hydrogen-high`. Smoke test:
   ```powershell
   agy -p "summarise PLAN.md" --model <hydrogen-slug> --output-format json
   ```
   Check that the mod's `listModels` parser (first token of each line) matches the real `agy models` output.
3. **Set agy's permissions** in `~/.gemini/antigravity-cli/settings.json`. Headless mode quietly skips anything that needs approval and still exits 0, so allow what's needed explicitly:
   ```json
   { "permissions": {
       "allow": ["write_file(crates/)", "command(regex:cargo (check|fmt|clippy|test))"],
       "deny":  ["command(git push)", "command(git commit)", "command(rm -rf)", "write_file(.git/)"] } }
   ```
   Don't use `--dangerously-skip-permissions`.
4. **Make the mod load in every session.** Done: installed as `GeminiClaude@GeminiClaude` from a folder marketplace (`GeminiClaude/.claude-plugin/marketplace.json`), read straight from this folder in the CLI and the desktop app. After edits run `/reload-plugins`. The old skills-folder junction did not load and was removed.
5. **Trial it.** Give the same small task to Hydrogen and to Haiku, then compare the result and the speed. Claude reviews any Gemini diff before committing.

## Known limits

- **30-minute cap:** a run streams through `$.process.spawn` (`--output-format stream-json`) and is stopped after 30 minutes, checked when output arrives; a silent hang is not cut.
- **No thinking text:** agy's stream gives a `thinking_tokens` count per step, not the reasoning itself.
- **Parallel only inside one call:** the engine runs this tool's calls one at a time (measured 2026-11-14: two calls in one message ran back to back), so several Geminis work at once only as `tasks` of one call, and Claude waits for all of them. The cap of 5 is a guess at the plan's rate limit.
- **Shared working tree:** parallel runs edit the same folder, so give them files that don't overlap.
- **No follow-ups:** a Gemini subagent can't be continued with SendMessage, and it starts with none of this conversation's context.
- **Unpublished quota:** the Pro plan's limit resets every 5 hours up to a weekly cap, and Google gives no numbers.
- **Brief length:** a brief over 30,000 characters is refused, because agy takes the prompt only as a command-line argument and Windows caps a command line at 32,767 characters. Put long context in a file and name it in the brief.
- **Non-Gemini slugs:** `agy models` also lists Claude and GPT-OSS slugs and the mod offers whatever agy lists, though its wording says "Gemini".
- **Claude models in agy:** Claude Sonnet and Opus 4.6 inside agy are removed on 2026-11-18. Don't build on them.

## Sources

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/getting-started/?tab=cli
- https://antigravity.google/docs/permissions?tab=cli
- https://antigravity.google/docs/models/
- https://antigravity.google/docs/plans/
