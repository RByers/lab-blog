# AGENTS.md

## Repository

The canonical remote is https://github.com/RByers/lab-blog (`origin`).

## Landing work

Work happens on a branch (often a worktree branch), but it lands on `main`
locally and goes out from there:

1. Merge the branch into `main` — fast-forward when possible.
2. Push `main` to `origin`.

No pull request, no fork, no review branch on the remote. Always get the
user's confirmation on the change before landing it; never push unreviewed
work.
