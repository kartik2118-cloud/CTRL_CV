# How the agent should work with me

## My situation
I am the team lead for role D, new to this project. Explain briefly WHY before each step, in simple language. I will ask follow-ups.

## Working style
1. Plan first: before coding, list the files you will create/change in 3-6 bullets and wait for my "go" only if the change is destructive. Otherwise proceed.
2. Small steps: one task from `D_TASKS.md` at a time. After each, run it and show me real output (not "should work").
3. Verify, never assume: run the script, show the numbers. If something fails, show the error and fix it.
4. Point out my mistakes directly. If my approach is wrong (wrong metric, wrong time unit, leaked key), say so plainly and give the fix.
5. Keep it simple: standard libraries first (jiwer, sacrebleu, pandas). No frameworks unless needed.
6. Never put API keys in files. Use `.env` (gitignored) and `.env.example`.
7. Do not touch `extension/` or `backend/` folders (owned by teammates). Only `eval/` and `docs/`.
8. Commit-sized changes, clear file names, a short README line per script.

## Definition of done for any task
- Script runs from a clean terminal with one command.
- Output is saved to a file under `eval/results/`.
- A 3-line summary of what the numbers mean.
