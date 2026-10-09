# Server

Capability: server

## Purpose
Keeping the models repositories send and answering view requests with
diagram text ready to paste into documentation, and serving a product's wiki
when it is given a product folder (capability product-wiki). A repository's
model reaches the server only when it is sent, with the commit it describes:
the server never clones or reads a repository to build a graph, and each
repository sent is a graph of its own in this milestone. The one repository it
reads is the product folder it is given, read-only, as that product's wiki's
working tree.

## Requirement: send — A repository's model is sent after its check passes
When the send command is run on a checkout of a repository with a server's
address, it shall run the model check on the repository at the asked revision
(by default `HEAD`) and, only if the check passes, send the compiled model
with the source's name, the revision's commit id and its commit time. The
source's name is the one given, else the repository's `origin` remote as host
and path without a scheme, credentials or a trailing `.git`. If the check
fails, nothing is sent and the command exits 1 with the check's findings; if
there is no name to give the source, no server address, or the server cannot
be reached, it exits 2 naming what is missing.

### Scenario: sent-after-check
- Given: a repository whose `origin` is `git@github.com:shady2k/nocx.git` and whose model passes the check at `HEAD`
- When: the send command is run with the server's address
- Then: the server stores the model as source `github.com/shady2k/nocx` at `HEAD`'s commit and commit time, and the command prints the source, the commit and that it was stored

### Scenario: check-fails
- Given: a repository whose model names evidence past the end of a file
- When: the send command is run
- Then: nothing reaches the server, and the command exits 1 printing the check's error with the file and line

## Requirement: store — A model sent is kept in the source's history
When a model is sent for a source at a commit, the server shall check it
against the compiled model's schema and store it in that source's history as
the model history stores a version, answering whether it was stored or was
already there. Sending a commit already stored changes nothing. The same
commit sent with a different model or commit time is refused, naming the
commit. A model that does not match the schema is refused, naming every path
that does not. Each source is its own graph: ids in one source never clash
with another's, and nothing in one source is shown in another's views.

### Scenario: repeat-send
- Given: the reference system stored at commit `c1`
- When: the same model is sent at `c1` again
- Then: the answer says it was already stored, and every view answers byte for byte as before

### Scenario: invalid-model
- Given: a model whose element lacks `kind`
- When: it is sent
- Then: it is refused with the element's path in the model and `kind` named, and the source's history is unchanged

### Scenario: separate-graphs
- Given: two sources that each declare an element `core`
- When: both are sent
- Then: both are stored, and the view of `core` in each source shows only that source's elements

## Requirement: view — A view request is answered with diagram text
When a view is requested for a source, with an element (left out, the
landscape), a depth (by default 1) and a format (`mermaid` or `likec4`), the
server shall answer the view of that source's graph at the current time and
the first state, as the views capability renders one view on request: for
`mermaid` a Markdown fragment with the flowchart and its table of arrows, for
`likec4` a workspace that `likec4 validate` accepts on its own. The same
model, element, depth and format give the same bytes.

### Scenario: domain-as-mermaid
- Given: the reference system sent
- When: the view of the domain `ordering` is requested as Mermaid at depth 1
- Then: the answer is a Markdown fragment whose flowchart Mermaid's parser accepts, framing the children of `ordering` with its neighbours outside it, and its table lists every arrow

### Scenario: module-view-as-likec4
- Given: nocx's model sent
- When: the view of its core is requested as LikeC4
- Then: the answer, saved as a file, passes `likec4 validate` and holds a view of the core showing its modules

## Requirement: explains — A request that cannot be answered says why and what to do
If a view is requested for a source never sent, then the server shall answer
that no model has been sent for it, list the sources it holds, and name the
command that sends one. If the element does not exist in the source's model
now, or the depth or the format is not one it accepts, then it shall answer
naming the value and what it accepts. Every refusal names the request's
fields at fault; none is answered with an empty diagram.

### Scenario: unknown-source
- Given: a server holding only `github.com/shady2k/nocx`
- When: a view of source `github.com/acme/shop` is requested
- Then: the answer is "not found", saying no model has been sent for `github.com/acme/shop`, listing `github.com/shady2k/nocx`, and naming the send command with its arguments

### Scenario: unknown-element
- Given: the reference system sent
- When: the view of element `billing` is requested
- Then: the answer is "not found", naming `billing` and the source

## Requirement: sources — What the server holds is listed
When the server is asked for its sources, it shall list each source with the
commit and commit time of its latest stored version and when that was stored,
in code point order of the source names.

### Scenario: list
- Given: nocx and the reference system each sent once
- When: the sources are asked
- Then: both are listed with their commits and times

## Requirement: serves-wiki — A server given a product folder serves that product's wiki
When the server is started with a product folder, it shall serve that
product's wiki: its pages read from the product's working tree, madarch's app
from the files madarch's build produced, and refusals naming what was asked
for (capability product-wiki). It shall print the address it listens on, and
serving shall change neither the product's files nor its repository. Started
without a product folder it shall serve no wiki, and started with neither a
product folder nor a data folder it shall refuse to start, naming what it
needs.

### Scenario: product-folder-served
- Given: a draft product folder
- When: the server is started with it
- Then: it prints its address, and that address answers the product's home page and the page of a document saved in the product

### Scenario: sent-models-and-the-product-stay-apart
- Given: a server started with a data folder and a product folder, and one model sent
- When: a view of the sent source and a page of the product are asked for
- Then: the view is answered from the model that was sent, the page from the product's working tree, and the product's files are unchanged

## Requirement: survives-restart — What was stored is there after a restart
When the server is started on a data folder that already holds sources, it
shall answer every view request exactly as before it stopped, rebuilding its
query engines from the stored histories.

### Scenario: restart
- Given: nocx sent and one view's answer recorded
- When: the server is stopped and started again on the same data folder
- Then: the same request gets byte-identical text

## Requirement: identities — Every source has a stable server-assigned id, surviving a rename
When a source is first sent, the server shall assign it an opaque id that no
later send, rename or restart changes. `GET /sources` shall list each source
with its id beside its name. A repository renamed and sent under its new name
shall keep the same id once the rename is recorded as a claim, and the server
shall never hold two ids for one repository.

### Scenario: id-is-stable
- Given: nocx sent once
- When: the sources are listed, and nocx is sent again after a restart
- Then: both listings show the same id for nocx

### Scenario: rename-keeps-identity
- Given: nocx sent once, with its id recorded
- When: the same repository is sent under a new name, with the rename claimed
- Then: the source keeps its id, its histories and its view answers; the old name no longer creates a second source

## Requirement: immutability — The same source and commit can be resent only with identical bytes
When a send arrives for a source and commit the history already holds, the
server shall answer already stored when the digest of the incoming model
equals the digest of the stored one, changing nothing; and shall refuse the
send otherwise, naming both digests and the source and commit, without
changing what is stored.

### Scenario: identical-bytes
- Given: nocx's model stored at commit c1
- When: the same model bytes are sent again for c1
- Then: the answer is already stored and every stored answer is byte-identical

### Scenario: different-bytes
- Given: nocx's model stored at commit c1
- When: different model bytes are sent for the same source and c1
- Then: the send is refused, both digests are named, and what is stored is unchanged

## Requirement: protocol — Every request names its protocol version, answered within a stated range
Every request shall carry a protocol version, and every answer shall name the
version the server speaks. A request whose version is outside the server's
supported range shall be refused naming the range, before anything else is
read from the request.

### Scenario: version-too-old
- Given: a server supporting versions 1 through 1
- When: a request names version 0
- Then: the request is refused naming the supported range, and nothing is stored

### Scenario: version-named
- Given: any successful request
- When: the answer arrives
- Then: the answer names the protocol version the server speaks

## Quality requirements
- Performance: a view of the reference system answers in under one second once its source's engine is built; storing a 1 000-element model takes under five seconds.
- Reliability and recovery: a sent model is stored in one transaction, all of it or none; the query engines are derived and rebuilt from the histories on start; memory levels off over days of requests (see graph-queries).
- Security and data protection: no authentication in this milestone (decision 0012): the server listens on `127.0.0.1` unless told otherwise; it reads no repository to build a graph, the one repository it reads is the product folder it is given and only its wiki's pages, and it makes no outbound call.
- Data: every version sent is kept, append-only, in the data folder, one history per source.
- Usability: every refusal names the field at fault and what is accepted; a source never sent names the command that sends one.
- Operation: one log line per request on standard output (method, path, status, source, milliseconds); a refusal also logs its message, a failure of the server itself logs at error level with its cause. Runs under Bun 1.4.2 on macOS and Linux, started with a data folder or a product folder, and it refuses to start with neither.

## Context
Decisions 0007 (the server is the target; ingest is one idempotent operation,
amended: in this milestone the model is sent, not fetched), 0012 (no
authentication), 0013 (one graph per server, amended: in this milestone each
source is its own graph), 0009 (the query engine is derived from the
history), 0017 and 0018 (the product wiki is served by the local madarch over
that product's working tree). Capabilities model-check (the check the send
command runs), model-history (how a version is stored), views (one view on
request), graph-queries, product-wiki (the wiki a product folder is served
as).

## Coverage limits
One repository per graph: relations between repositories and joining them by
contract ids are the next milestone. Views are answered at the current time
and the first state only; history, environments and states are stored, not
yet asked for. No webhooks, polling, CI trigger, authentication, Docker
image or wiki hosting.
