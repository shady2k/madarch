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
serves until you stop it; leave it running, open another terminal, and keep
reading. Later serves open immediately unless the port is taken (`the port
4180 is already in use: nothing else can serve there — name another with
--port <n>`).

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
command serves until it is stopped.

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

## How the commands find the product

The lifecycle commands (`rename`, `remote`, `repo add`, `bootstrap`) take
the product from where you stand: the product the working folder is, or the
product a checkout under its `repos/` is checked out from. Run a command
where no product stands above, and it refuses with exit 2, naming the
folder it looked from and the `--product` it would have taken:

    no product was found above /home/you/somewhere: run the command in a product folder or in a checkout under its repos/, or name the product with --product <folder>

Name a product explicitly when the command is run from elsewhere:
`--product ~/madarch/products/gadgets`.
