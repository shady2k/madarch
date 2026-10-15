# Existing checkout selection is explicit; madarch searches no conventional folder

Change: repo-add-source-selection
Base: a34287f1e98e1bdf5ff32d7127a981bbc6ef84f9
Tasks: madarch-74k4.1.1
Kind: supporting

## Intent
Record the owner's 2026-10-15 correction to madarch-74k4's source-selection plan before implementation. Madarch does not search a conventional local checkout directory. The person supplies a local checkout path, or runs the command from the checkout (the current directory or its Git top level). If the person supplies only a URL, madarch offers a clone unless the person also points to a local checkout.

## Out of scope
- Implementing `madarch init`, `madarch repo add`, checkout linking, moving, cloning, or product discovery.
- Searching any conventional or presumed location for a checkout.
- Product behavior beyond explicit checkout source selection.

## Rationale
The owner corrected the assumption that checkout directories have a standard location: «Нет такой стандартной папки». A path chosen by the person, or the checkout from which the command is run, is an explicit source. Searching an assumed location would be unreliable and could select the wrong repository. The owner also clarified that the one-time acceptance walk uses a scratch clone of madarch's own public repository, prepared with a local branch, uncommitted work and a stash. This walk exercises link (the default), move and clone; committed tests continue to use small temporary Git fixtures only.

## Changes to requirements
None. This supporting record narrows the source-selection assumptions for the planned feature; implementation and its behavioral requirements belong to a feature change record.

## Preserved contracts
None.

## Coverage
None.

## Blocking questions
None.

## Design and decisions
- An explicitly supplied local path is the local source.
- When invoked inside a Git checkout, the current directory or its Git top level is the local source.
- Given only a URL, do not search for checkouts. Offer clone; offer a local checkout only when the person points to one.
- The acceptance walk clones `https://github.com/shady2k/madarch` into a scratch folder, then gives that checkout a local branch, uncommitted work and a stash. The guided path exercises link by default, move and clone. No write is made to the remote repository.
- Committed tests use small temporary Git repositories created locally; they do not use the acceptance checkout, an outside checkout, or the network.
