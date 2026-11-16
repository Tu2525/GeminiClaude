# GeminiClaude

A Claude Code plugin that lets Claude hand routine work to Google's Gemini models. Claude writes the brief, the [Antigravity CLI](https://antigravity.google/docs/getting-started/?tab=cli) (`agy`) runs it on a Gemini model, and the reply comes back to Claude like a subagent's result.

Use it to keep Claude usage for the work that needs Claude. Searches across many files, first-pass reviews and simple edits go to Gemini, which runs on your Google AI plan instead.

```
✦ Gemini running  3 agents                               Hide
› Pre-publish secrets scan          gemini-3.8-flash-medium
› Review band render hook           gemini-4-argon-medium
› Check PLAN.md against code        gemini-4-hydrogen-low
```

## What you get

- **A `delegate` tool for Claude.** Claude calls `mcp__GeminiClaude__delegate` with a model, a short label and a complete brief. The plugin also adds a short section to the system prompt so Claude knows to weigh Gemini whenever it would start a subagent.
- **Parallel runs.** One call takes up to 5 tasks and runs them at the same time, one `agy` process each. The replies come back together, each under its task's heading.
- **A band above the prompt.** It shows which Gemini agents are running, then the last run's model, time, tokens and whether it succeeded. Press Hide to put it away; the next run brings it back.
- **An optional picker.** Turn on `askOnSpawn` and you are asked "Claude or Gemini?" each time Claude starts a subagent.

## Requirements

- Claude Code with plugin hooks modules (mods).
- `agy`, the Antigravity CLI, installed and signed in with a Google account whose plan includes it. No API key is needed.

Tested on Windows 11 with agy 1.5.9. Other platforms should work wherever `agy` is on the `PATH`, but are untested.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install GeminiClaude --marketplace Tu2525/GeminiClaude
```

Answer `y` to add the marketplace, then pick a scope. Or from a shell:

```bash
claude plugin install GeminiClaude --marketplace Tu2525/GeminiClaude
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Tu2525/GeminiClaude`, then Add plugin.

## Set up agy

1. Install it (PowerShell on Windows; see the [Antigravity docs](https://antigravity.google/docs/getting-started/?tab=cli) for other platforms):

   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```

2. Run `agy` once and sign in.
3. Check that it lists models:

   ```bash
   agy models
   ```

4. Give it the permissions your tasks need, in `~/.gemini/antigravity-cli/settings.json`. Headless `agy` silently skips any action that needs approval and still exits 0, so allow what you want explicitly:

   ```json
   {
     "permissions": {
       "allow": ["write_file(src/)", "command(regex:npm (test|run lint))"],
       "deny": ["command(git push)", "command(git commit)", "command(rm -rf)", "write_file(.git/)"]
     }
   }
   ```

   With no `allow` rules, Gemini can still read, search and review. See the [permissions docs](https://antigravity.google/docs/permissions?tab=cli). Do not use `--dangerously-skip-permissions`.

Start a new Claude Code session afterwards. If `agy` is missing or signed out, the plugin stays out of the way and the status line says `gemini: agy not found or signed out`.

## Use it

Ask Claude in plain words:

- "Have Gemini find every caller of `parseConfig`."
- "Get a first-pass review of this diff from argon."
- "Run three Gemini agents at once: one per package, each listing its unused exports."

Claude also picks Gemini by itself for routine, self-contained work. Name a model family (hydrogen, argon, flash) and it uses that one. The models offered are whatever `agy models` lists for your account.

Each Gemini run starts cold: it sees the working directory but nothing of your conversation, so Claude has to write it a complete brief. Its edits land in your working tree, and Claude is told to review the diff before relying on it.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `askOnSpawn` | off | Before a Claude subagent starts, asks whether to run it on a Gemini model instead. Offers up to three models, Hydrogen and Argon first. |
| `autoHaiku` | off | Before a Claude subagent starts, judges its brief and runs a trivial one (a lookup, a search, a small edit) on Haiku, without asking. A model Claude names is kept. |

## Limits

- **Claude waits for the batch.** Runs are not in the background: a call returns when its last task finishes.
- **10 minutes per task.** A run is cut off after that.
- **5 tasks per call.** This is a guess at what the plan's rate limit bears, since Google does not publish it. It is one constant, `MAX_PARALLEL`, in [register.tsx](GeminiClaude/hooks/register.tsx).
- **Parallel only inside one call.** Claude Code runs a plugin tool's calls one at a time, so two separate `delegate` calls run back to back.
- **One working tree.** Parallel tasks edit the same folder, so give them files that do not overlap.
- **No follow-ups.** A Gemini run cannot be continued; a second question is a new run.
- **Briefs up to 30,000 characters.** `agy` takes the prompt as a command-line argument. Put long context in a file and name it in the brief.
- **Not only Gemini.** `agy models` can list other vendors' models too, and the plugin offers whatever it lists.

## How it works

The plugin is one hooks module, [GeminiClaude/hooks/register.tsx](GeminiClaude/hooks/register.tsx).

1. At session start it runs `agy models` and registers the `delegate` tool with those slugs.
2. For each task it runs `agy -p "<brief>" --model <slug> --output-format json` and reads the JSON envelope: the reply, any error, and token usage.
3. A failed run comes back to Claude as a plain explanation, not as a silent empty reply.

[PLAN.md](PLAN.md) has the design notes and the reasons behind each choice.

## Develop

```bash
claude plugin validate GeminiClaude
```

```bash
claude plugin test GeminiClaude
```

The tests in [register.test.tsx](GeminiClaude/hooks/register.test.tsx) use real `agy` output as fixtures. To run the plugin from a checkout, start Claude Code with `claude --plugin-dir GeminiClaude`.

## Licence

[MIT](LICENSE)
