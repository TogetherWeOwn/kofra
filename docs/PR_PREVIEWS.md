# GitHub Action: pull-request previews

The composite action at the root of this repository publishes a built folder to
**your existing Kofra instance**, writes one PR comment with the preview URL,
and deletes that preview on PR close. It does not deploy a Worker or change the
instance configuration. No npm release of the CLI is needed: the action runs the
zero-runtime-dependency CLI source from the same reviewed action revision.

## Requirements and trust boundary

- A Linux runner with Bash and **Node 22.18+ with native TypeScript enabled**.
  `actions/setup-node` with Node 24 is recommended. The packaged CLI itself still
  supports Node 20; this source-based action has the newer runtime requirement.
- An existing Kofra instance and an API key with **unrestricted** `sites:read`
  and `sites:write` access. Use a **dedicated preview member/account**, not an
  administrative or production key. Cleanup verifies both scopes first and
  refuses site-restricted keys, since a restricted key cannot prove the preview
  is really gone. Preview files and URLs are public; never put credentials or
  private data in the build output. The CLI's normal secret-file checks apply,
  and symlinked files are refused outright: replace them with copies.
- `contents: read` to check out the project and `pull-requests: write` for the
  job's `GITHUB_TOKEN`. Repository/organization policy must allow that permission.
  The default GitHub Actions bot token is the supported comment identity.
- Only **trusted, same-repository** PRs. The action skips forks, unsupported PR
  actions and all event types other than `pull_request`. Same-repository code is
  not intrinsically safe: anyone who can push a branch must be trusted with the
  build job and its secrets. Do not use this workflow for untrusted contributors.
- Never switch to `pull_request_target`, check out fork code with privileged
  credentials, or forward secrets to a fork to get around a skipped preview.

## Workflow

Put the following in the **consumer project's** `.github/workflows/preview.yml`.
Replace `REVIEWED_COMMIT_SHA` with a reviewed immutable commit of this repository
that contains `action.yml`; do not copy the placeholder literally. Set the
repository variable `KOFRA_API` to your instance origin and the repository
secret `KOFRA_PREVIEW_KEY` to the preview member's key. Adjust the build command
and folder for your project. The build gets no Kofra key.

```yaml
name: PR preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: dropway-preview-${{ github.repository }}-${{ github.event.number }}
  cancel-in-progress: false
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          # A closed PR may have no branch or merge ref left. Cleanup needs no build.
          ref: ${{ github.event.action == 'closed' && github.event.pull_request.base.sha || github.event.pull_request.head.sha }}
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '24'
      - name: Build trusted PR
        if: github.event.action != 'closed'
        run: npm ci && npm run build
      - name: Publish or clean up
        id: preview
        uses: TogetherWeOwn/kofra@REVIEWED_COMMIT_SHA
        with:
          folder: dist
          api: ${{ vars.KOFRA_API }}
          token: ${{ secrets.KOFRA_PREVIEW_KEY }}
          github-token: ${{ github.token }}
```

The PR-number concurrency group is important: publish, comment update and close
cleanup must not overlap. Do not cancel a running publish on close; let cleanup
run afterward. GitHub concurrency is not a FIFO queue: do not manually rerun old
publish events after a PR closes, or they can recreate the preview. Re-run the
close event if a cancelled/failed workflow left a preview behind.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `folder` | Built directory inside `github.workspace`; defaults to `dist`. Spaces are supported. Not read on close. |
| `api` | Required instance origin, such as `https://kofra.example.com` (not `/api/v1`). |
| `token` | Required Kofra API key. Passed in the child environment, never command-line arguments. No anonymous fallback. |
| `github-token` | Defaults to `github.token`; requires PR comment read/write access. |

Successful publishing sets `steps.preview.outputs.url` and
`steps.preview.outputs.slug`. Both are empty on cleanup or a safe skip. Missing
credentials fail before publishing or commenting.

A preview's reserved name is `pr-<20 hex characters>-<PR number>`, where the hex
prefix is SHA-256 of the lowercase repository full name. Fresh runners and later
pushes reuse that name; different repositories and PRs do not share it. Reserve
this namespace for the action. Renaming/transferring a repository or changing
instances changes the identity; remove any old previews separately with the CLI.

The action paginates up to 10,000 comments to locate its marked comment and
edits it rather than appending on each push. Only a marked comment authored by
`github-actions[bot]` is ever edited; a copied marker from another bot or a
human is left alone (a custom `github-token` that comments as someone else gets
a new comment per run instead of an update). Close removes only the calculated
preview, without needing a checkout of the PR branch or a build folder.
Repeated close succeeds if the site is already absent, but only a verified
missing site is ignored: the key's scopes are checked first, unexpected
instance answers stay failures, and the instance must confirm deletion. The
original URL comment remains as a record; the deleted preview URL no longer
serves the files.

## Failures, verification and rollback

- GitHub comment access is checked before publishing. Failed writes can still
  leave a published preview (the APIs are not one transaction). Fix permissions
  and rerun the current event: the stable name and marker make it recoverable.
- The action emits fixed error messages and HTTP/CLI exit codes, not raw remote
  responses, child logs or credentials. CLI exit codes are documented in the
  [CLI reference](../packages/cli/README.md). A timeout or unexpected response is
  a failure, never a successful cleanup.
- No installs, repository scripts or package lifecycle hooks run inside the
  action. The CLI runs from the action's directory with a temporary config/cwd,
  so the consumer's `dropway.json` cannot redirect it to another instance/site.
- `npm run test:cli -- test/pr-preview-action.test.ts` exercises the actual
  composite Bash step, real CLI and local Worker (HTML/binary read-back), with a
  local GitHub comment API. It covers stable identities, pagination, update,
  cleanup/repeated cleanup, unsafe events, missing keys and credential-safe
  failures, plus symlink/outside-folder refusal, unsafe instance URLs,
  insufficient-scope and foreign-origin cleanup failures, bot-identity comment
  matching, and parent-environment isolation of the CLI child. This is not proof
  of a real GitHub workflow's permissions or a live
  instance deployment; validate those in a non-production preview account.
- Roll back by pinning the previous reviewed action commit or removing the
  consumer workflow. To remove a leftover preview, use `kofra delete <slug>
  --yes` with that preview account and explicit `--api <instance>`. Do not delete
  a production site. Changing the action does not migrate the instance or schema.
