# @agentoom/pi-reviewer

Post-task multi-area code review extension for [pi](https://pi.dev) by [agentoom.com](https://agentoom.com).

After every task, pi-reviewer prompts you to run a structured critique across 7 specialised areas — or you can call `/review` anytime.

## Install

```bash
pi install npm:@agentoom/pi-reviewer
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/review` | Open the review area picker and run selected reviews |
| `/review-toggle` | Toggle the auto‑offer prompt on/after each task |
| `/review-disable-project` | Disable auto-review for the current project (writes `.pi/review-config.json`) |
| `/review-enable-project` | Re-enable auto-review for the current project |

### Apply Review Findings

After the review completes, pi-reviewer scans the results for actionable issues (sections marked with ❌ or ⚠️ containing bullet points). If issues are found, you'll be prompted:

- **Apply fixes now** — the LLM reads the review findings, edits the affected files, and reports what was changed.
- **Skip** — the review is saved but no fixes are applied.

If the review found no issues, the prompt is skipped and the review is simply displayed.

### Auto‑offer

By default, pi-reviewer prompts you after every task completes. Choose:

- **Review (all 7 areas)** — run every area immediately
- **Pick which areas to review** — open the checkbox picker
- **Disable auto-offer** — switch to manual mode permanently
- **Skip** — dismiss for this task only

When auto‑offer is disabled, `🔍 auto-review` disappears from the footer, and pi-reviewer stays silent until you run `/review`.

Toggle it back on with `/review-toggle`.

### Disabling Auto-Review

#### For the current project (persistent)

Run `/review-disable-project` to write `autoReview: false` to `.pi/review-config.json`. The extension will skip auto-offering after each task. Use `/review-enable-project` to undo.

You can also create `.pi/review-config.json` manually:

```json
{ "autoReview": false }
```

#### For the current session only

Set an environment variable before starting pi:

```bash
REVIEWER_DISABLE_SESSION=true pi
```

This suppresses the auto-review prompt for that session only — other pi sessions (without the env var) are unaffected. The env var takes priority over the project config.

### Review Areas

| Area | Question |
|------|----------|
| **General** | Did the implementation satisfy the original task? |
| **Security** | Did it introduce vulnerabilities? |
| **Code Quality** | Is it maintainable and consistent? |
| **UI/UX** | Is the user-facing implementation complete? |
| **Testing** | Is it adequately tested? |
| **Performance** | Could it cause performance problems? |
| **Scope** | Did the agent change more than it should have? |

### Checkbox Picker

- `↑↓` — navigate
- `Space` — toggle an area
- `a` — toggle all areas
- `Enter` — run selected reviews
- `Esc` — cancel

## Development

```
pi-reviewer/
├── package.json
├── index.ts          # Extension entry point
└── README.md
```

## Links

- [agentoom.com](https://agentoom.com)
- [npm: @agentoom/pi-reviewer](https://www.npmjs.com/package/@agentoom/pi-reviewer)

Run against a local path:

```bash
pi install ./pi-reviewer
```
