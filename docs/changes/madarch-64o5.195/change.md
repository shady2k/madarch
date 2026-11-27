# Read the author of an authored change

Change: madarch-64o5.195
Base: f1917a675b56f0844abdacf725c43e3bf6c28e6e
Tasks: madarch-64o5.195
Kind: no-behavior

## Intent

The wiki journal and entity command show the configured name for local authorship. The wiki journal names the local MCP agent and the person it represents.

## Out of scope

Identity verification and historical browsing of deleted entities.

## Rationale

The identity authority supplies the person's name. The graph keeps that name in its protected identity label, with the same stable author ID. The journal uses a generic person label for installations that still carry the older machine-account label.

## Preserved contracts

- server/serves-wiki: the wiki reads the assertion source and author through GraphQL.

## Coverage

- server/serves-wiki: test

## Where it is seen

Kind: request
Place: an authored record's Details section, the entity CLI response, and the MCP `graph_query` response

1. Configure a local Git author and create a record through the wiki. Read the configured name in Details.
2. Change the configured name and update the record using the entity CLI. Check the name and stable author ID in the command response and the journal.
3. Create a record using MCP. Check that the graph names the agent as the source and the configured person as the author.
