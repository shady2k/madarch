# Start a product from the repositories you already have

Engineers keep a product's knowledge — its documents, its intended model,
its skills, its prototypes, the wiki — in a git repository of its own, apart
from the code. You do not have to start that repository empty: the code you
already have joins it as it is. This guide walks one product from nothing to
a pushed repository a colleague can clone, in commands that can be pasted
one after another.

The commands are the `madarch` program. Every one says what happened on
standard output, one fact per line, and what went wrong whole on standard
error: `0` when done, `2` when something you typed or named cannot be used
(the message names it), `1` when a step (usually git itself) failed.

## Install madarch

On a machine with Node.js 18 or newer, use the primary install:

    npx madarch new

The command creates a draft and serves its wiki. On macOS, Homebrew can install it with:

    brew install shady2k/tap/madarch

The release script is also available on Linux/macOS:

    curl -fsSL https://raw.githubusercontent.com/shady2k/madarch/main/scripts/install.sh | sh

On Windows x64, run `scripts/install.ps1` from PowerShell. Windows arm64 is not supported. `madarch new` writes the initial Git commit, so install Git and configure `user.name` and `user.email` before running it. madarch does not change your Git identity.

For contributors who want to run from a source checkout instead:

madarch runs with Bun, from a checkout of the madarch repository:

    git clone <your-fork-or-the-madarch-url> madarch

(`<your-fork-or-the-madarch-url>` is a placeholder: the address you clone
from. The shell would read a bare `<...>` as redirection, so a placeholder
is never pasted as is.)
    cd madarch
    bun install --frozen-lockfile
    bun link

`bun install --frozen-lockfile` installs Bun's dependencies of the checkout.
`bun link` makes the linked `madarch` command available on your PATH:

    madarch --help

prints one usage example per subcommand, then what each does and what
each option does (`--port <n>` serves on another port, `--no-open` skips the
browser, `--home <folder>` and `--product <folder>` point at a products home
and a product folder for one command).

## Start from an existing checkout

If you already have a Git checkout, enter it and run:

    cd <checkout>
    madarch init

`madarch init` creates a separate product under the products home, links the
checkout without moving it, commits the product repository and serves its wiki.
It uses the checkout folder name and its `origin` URL when present. With no
origin, it links the checkout and reports that no origin URL is set. The
checkout remains where you work. Outside Git, use `madarch new` instead.

## Create the draft


    madarch new

makes the draft product repository under the products home, `~/madarch/products`
(and opens its wiki in your browser). The folder is named for the day:
`idea-2026-10-09`, then `idea-2026-10-09-2` for the second draft that day.
It prints the draft's folder and id, then serves the wiki:

    folder: /home/you/madarch/products/idea-2026-10-11
    id: 473611d2-ffdd-408e-b94c-143221f4c343
    address: http://127.0.0.1:14280

The addresses and ids here are this guide's run's; yours will be yours (the
folder is named for the day you run it). The first serve builds the wiki's
app in the madarch checkout and serves it from there, saying so while it
builds, and does not build again while the built files stand. The other lines name the draft and its id —
the identifier the product keeps for its whole life, whatever the folder
is later called. The command
The command serves in the foreground until you stop it with Ctrl-C — that
is the whole session ending, not a fault. Without a browser (a headless
machine, or `--no-open`) it prints the `address:` line and keeps serving the
same way; for a bounded look, run it under a timeout (`timeout 60 madarch
new --no-open`) and the serve ends with the timeout. Leave it running, open
another terminal, and keep reading. Later serves open immediately unless the
port is taken (`the port 4180 is already in use: nothing else can serve
there — name another with --port <n>`).

A products home is a folder of products; move it for real life with
`MADARCH_HOME`, for a single command with `--home <folder>`.

## Name the product

The draft's name is its folder's name. `madarch new` printed the folder —
the example below carries the folder this guide's run printed, named for the
day it ran; yours is named for the day you run it:

    cd ~/madarch/products/idea-2026-10-11
    madarch rename gadgets

renames the folder in place to `products/gadgets`, writes the new name in
the manifest `workspace.yaml` as one commit of the product's own history,
and prints:

    folder: /home/you/madarch/products/gadgets
    id: 9e0f6a2c-6d3e-4a58-9c1e-2b7f0a45e3d1
    name: gadgets

The id and every other byte of the manifest are kept. Run it from anywhere
the product is above you: inside the product folder, or inside a checkout
under its `repos/`. What refuses it, each with exit 2 and the reason named:
a name already taken in the products home (`the folder ... is in the way`),
a name the product already has, changes that are not committed (`the folder
... holds changes that are not committed: commit them first, since naming
the product is a commit of its own and would take them with it`), and a
name a folder cannot take.

## Add the repositories you already have

Each existing code repository is declared and cloned in one step. From
inside the product:

    madarch repo add library ../library.git
    madarch repo add frontend ../frontend.git --branch main

enters the repository in the manifest (`workspace.yaml`, `repos:` list) and
clones it into the product's `repos/library`, so you have the checkout at
once:

    folder: /home/you/madarch/products/gadgets
    repo: library
    url: ../library.git
    cloned: /home/you/madarch/products/gadgets/repos/library

The `branch:` line appears when `--branch` named one. What refuses, with
exit 2: a name the manifest already declares (`the manifest ... already
declares the code repository "library": each repository is declared once,
and clones into its own folder`), changes that are not committed, an empty
url and a name that is no folder name. A checkout already standing at
`repos/library` is named and left as it is, never replaced.

To bring a declared repository home again, say after a fresh clone of the
product, `madarch bootstrap` clones what the manifest declares, one line per
repository: `cloned: ...` for a checkout made now, `present: ...` for one
that stood there and was left as it is. Nothing declared, no output.

## Commit, add your remote, push

The product's history is its own; nothing pushes for you. `madarch rename`
and `madarch repo add` commit to it; when you want the work on GitHub (or
anywhere), add the remote and push yourself:

    madarch remote ../gadgets.git
    git push -u origin main

`madarch remote` adds `origin` and prints:

    folder: /home/you/madarch/products/gadgets
    remote: origin
    url: ../gadgets.git

It never pushes. An `origin` already there is refused (`the folder ...
already has the remote "origin" ...`), never silently repointed; point it at
another url with your own git if you mean to.

## A colleague joins

A colleague clones the product's remote — the url you pushed to, which for
this walk is a folder on the shared machine; for a real product it is its
GitHub or GitLab url — into their own products home:

    madarch clone <the product's url>

The folder is named after the url (`gadgets.git` minus `.git`), the product
is read, and whatever the manifest declares is cloned under `repos/`; the
command prints the product, its id and the command that opens its wiki:

    folder: /home/you/madarch/products/gadgets
    id: 9e0f6a2c-6d3e-4a58-9c1e-2b7f0a45e3d1
    name: gadgets
    cloned: /home/you/madarch/products/gadgets/repos/library
    wiki: madarch serve --product /home/you/madarch/products/gadgets

The colleague runs `madarch serve` (see below) and works from the same
product folder as before. A url that is no product repository is refused
naming its manifest, and nothing is left behind.

## Open the wiki

From the product folder:

    madarch serve

prints the address and opens the browser:

    address: http://localhost:4180

The wiki is served out of the product's files, reading them fresh at every
ask: save a document under `docs/`, refresh, and the page shows it. The
command serves in the foreground until you stop it with Ctrl-C; with
`--no-open` it prints the address and serves the same way, and
`timeout 60 madarch serve --no-open` gives a bounded look.

## Start the work with your agent

The skills run where the product runs. Start Claude Code in the product
folder and install the skill set's tracker and document checks into it:

    claude
    # then, to the agent:
    run setup-shady2k-skills

`setup-shady2k-skills` sees a product repository as the special case it is:
the tracker lives in the product repository, the product-documents check is
wired as its commit gate, and no document places are asked about — the
layout's places stand. A checkout under `repos/` belongs to the product's
tracker too: its commits name the product's task ids.

Then talk the product through with the agent: what it is for, who needs it,
how you will know it works — in plain words, the agent's questions, your
answers. The agent writes the product's documents (`docs/vision.md` first,
then sources, hypotheses, stories, use cases, requirements) and the wiki
shows each one live as it is written and saved.

## Describe each repository you connected

The repositories under `repos/` join the product as code; the product's wiki
shows documents. Before describing, give the product the describing step:
it comes with the skill set, shady2k-skills 0.106.0 or later — not with the
madarch checkout, which ships no skills. Start the product's agent in the
product folder and install the set into the product if you have not already
(the step above, `run setup-shady2k-skills`); the installation lays the
describing section below the maintained markers of the product's
`AGENTS.md`.

Then ask the agent that runs in the product folder to describe a repository:

    describe the library repository for this product

The agent follows the set's describing skill, and for each repository:

1. writes the repository's intended model into the repository's own
   `madarch/` folder with the set's model-writing skill and the model check —
   every element, interface and relation carrying the file, the lines, the
   commit and the blob it was read from;
2. writes the repository's architecture page under the product's
   `docs/repositories/library/`, prose that names the model's views and
   links them;
3. writes what the code can do as requirements and use cases marked
   derived from code, each statement naming the file and the lines it was
   read from;
4. writes the decisions found in the code or in the repository's own ADRs
   as decision records, each linked to the model elements it shapes.

Everything is written as the wiki's pages: the wiki's live stream carries
every save, so a file written under `docs/` shows on its page
within two seconds, without a reload. Describe each repository you connected:

    describe every repository under repos/

A repository that holds uncommitted changes is refused before anything is
read: the evidence the model pins is committed text (`git -C repos/library
status --porcelain` must print nothing). What the agent writes lands in two
places — the model in the repository's `madarch/` folder (kept with that
repository's own history), the pages in the product's `docs/` (kept with the
product's) — and nothing of it needs the wiki restarted.

One honest limit: the wiki's pages are the product's `docs/` and `README.md`
only, so a page's relative links into `repos/<name>/madarch/` (the model and
its review report) show as plain text on the wiki page, not as links. They
are real links in the checkout and on the repository's host; the diagrams
work serves the models themselves. Keep them as citations — the walk keeps
them, named for what they are.

## How the commands find the product

The lifecycle commands (`rename`, `remote`, `repo add`, `bootstrap`) take
the product from where you stand: the product the working folder is, or the
product a checkout under its `repos/` is checked out from. Run a command
where no product stands above, and it refuses with exit 2, naming the
folder it looked from and the `--product` it would have taken:

    no product was found above /home/you/somewhere: run the command in a product folder or in a checkout under its repos/, or name the product with --product <folder>

Name a product explicitly when the command is run from elsewhere:
`--product ~/madarch/products/gadgets`.
