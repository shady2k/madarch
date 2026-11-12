# Source review records

Task: madarch-64o5.28. Access date: 2026-11-12. These records separate successful retrieval from substantive reading and record inaccessible material. Local paths mentioned below are scratch evidence, not a runtime dependency.


---

## Review batch 0

# Prerequisite proposal source access — groups 0

Task: madarch-64o5.28. Access date: 2026-11-12. Proposal only; no repository files changed.

Read all 80 owned YAML definitions/descriptions and all 521 candidate catalog records (519 real kinds; everything/none are presets outside these owned groups). Canonical IDs are used in this proposal as requested; parent normalizes to actual basename names using /tmp/derives-id-to-name.json. Attempted or reused shared cached HTTP access for all 47 unique cited URLs. A successful HTTP status is not treated as successful standard reading. sourceEvidence records the provenance URL, including inaccessible citations; access limits below are authoritative.

## Scope and assumptions

- dependsOn is conjunctive, so alternative methods/targets are not all listed as if all were necessary. Where no neutral evidence or entity superkind exists, the proposal uses the nearest common context and flags this below.
- These are semantic fill prerequisites, not extraction file dependencies or all relation links. Existing code.file depends-on examples were not copied: code.file is not an exact ID in the current catalog.
- Roots are individually justified in rootReason: practice.product, org.organization, backstage.user, iso25010.quality-characteristic.
- Driver → assessment → goal is deliberately acyclic; requirements use goals/scenarios and never feed goals. Child/parent aggregate dependencies are never both directions.

## Concerns for integration review

- Research-finding needs actual evidence in reality, but interview, observation, survey and usability sessions are alternatives. No generic research-study/evidence kind exists; practice.evidence is specifically acceptance evidence. Draft therefore records research-question as common prerequisite and requires evidence in the rationale rather than asserting all research methods must exist.
- backstage.owner can be a person OR group; draft does not require both user and team to exist. practice.assignment uses concrete user target as default and flags group assignment as alternative. org.membership uses team as nearest group kind, but ORG also allows membership directly in organisation/unit. These polymorphic cases require owner review if the field cannot express alternatives.
- practice.evidence uses istqb.test-result as concrete check-result input; non-test acceptance checks/review evidence are possible, but no general check-result superkind exists.
- practice.feature uses epic as nearest planned need; standalone features can be expressed without an epic in source standards. practice.release-plan uses roadmap-item rather than requiring a delivered release. These choices need owner review for desired universal gate strictness.
- Live linked decision0033 reservation semantics conflict with catalog definition; no silent correction made. Live architecture talk did not show C/B/A lanes.
- Standards pages do not normatively prescribe these exact mandatory dependency lists. Source and catalog meanings guide design judgment; source access limits are explicit.

## URL access and relevant findings

### https://adr.github.io/
- HTTP/access result: `200`; final URL: https://adr.github.io/; accessed 2026-11-12.
- Substantive public article read. ASR is a requirement with measurable effect on architecture and quality; decisions address ASRs, not the reverse.

### https://arc42.org/overview
- HTTP/access result: `200`; final URL: https://arc42.org/overview/; accessed 2026-11-12.
- Public template overview read. Sections 1/2 frame goals and constraints, 10 addresses quality requirements/scenarios, 12 glossary. Overview is not detailed guidance or a mandated dependency graph.

### https://backstage.io/docs/features/software-catalog/system-model
- HTTP/access result: `200`; final URL: https://backstage.io/docs/features/software-catalog/system-model/; accessed 2026-11-12.
- Public documentation read. Systems encapsulate components/resources; domains group systems by business purpose. Grouped systems are not prerequisites to identifying the business domain.

### https://backstage.io/docs/features/software-catalog/well-known-relations
- HTTP/access result: `200`; final URL: https://backstage.io/docs/features/software-catalog/well-known-relations/; accessed 2026-11-12.
- Public relation definitions read. Ownership is accountability by User or Group; ownerOf/ownedBy are inverse links, as are membership relations. Inverse links do not imply two-way prerequisites.

### https://c4model.com/abstractions
- HTTP/access result: `200`; final URL: https://c4model.com/abstractions; accessed 2026-11-12.
- Public abstraction documentation read from cached HTML. People (actors, roles, personas, individuals) use software systems; an actor is not necessarily a login identity.

### https://committee.iso.org/standard/78176.html
- HTTP/access result: `200`; final URL: https://committee.iso.org/standard/78176.html; accessed 2026-11-12.
- Public abstract only read. ISO/IEC 25010:2023 supplies a product-quality reference model with nine characteristics and subcharacteristics to specify, measure and evaluate quality. Full standard is sold; not read.

### https://cucumber.io/docs/gherkin/reference/
- HTTP/access result: `200`; final URL: https://cucumber.io/docs/gherkin/reference/; accessed 2026-11-12.
- Substantive public reference read. Feature gives a high-level description; Rule expresses a business rule implemented by software; scenarios illustrate it. Scenario aggregation in Gherkin is not a prerequisite from feature identity to already-written scenarios.

### https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users
- HTTP/access result: `200`; final URL: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users; accessed 2026-11-12.
- Public page read. Assignees clarify who works on an existing issue/PR. It supports work-plus-recipient inputs, not the product-specific branch-handoff operation.

### https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones
- HTTP/access result: `200`; final URL: https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones; accessed 2026-11-12.
- Public page read. Milestones group issues/PRs, with descriptions and due dates. Catalog narrows scope to epics; epics need not await a milestone to exist.

### https://docs.github.com/en/pull-requests/collaborating-with-pull-requests
- HTTP/access result: `200`; final URL: https://docs.github.com/en/pull-requests; accessed 2026-11-12.
- Public documentation index read. PRs propose changes and reviews precede merge. Index contains no mandatory review-checklist model; proposed checklist prerequisite is a catalog-informed design judgment.

### https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges
- HTTP/access result: `200`; final URL: https://docs.github.com/en/pull-requests/reference/pull-request-merges; accessed 2026-11-12.
- Public merge guidance read. Merge commit, squash and rebase integrate proposed changes. It does not define madarch lanes C/B/A.

### https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews
- HTTP/access result: `200`; final URL: https://docs.github.com/en/pull-requests/reference/pull-request-reviews; accessed 2026-11-12.
- Public review guidance read. Reviews comment on changes and choose comment/approve/request changes; findings arise from reviews, not vice versa.

### https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- HTTP/access result: `200`; final URL: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners; accessed 2026-11-12.
- Public CODEOWNERS guidance read. Repository file patterns name individuals/teams with write permissions and can trigger review requests. This is review responsibility, not general operational product ownership.

### https://en.wikipedia.org/wiki/Jobs_to_be_done
- HTTP/access result: `403`; final URL: https://en.wikipedia.org/wiki/Jobs_to_be_done; accessed 2026-11-12.
- HTTP403; response requests respecting robot policy. Article not read. Job-to-be-done proposal follows explicit catalog definition only.

### https://github.com/shady2k/madarch/blob/main/docs/decisions/0033-one-workflow-by-entity-kinds.md
- HTTP/access result: `200`; final URL: https://github.com/shady2k/madarch/blob/main/docs/decisions/0033-one-workflow-by-entity-kinds.md; accessed 2026-11-12.
- Public live main decision read. It covers typed graph walking, notes, questions, verification, optimistic parallel reservation and corrections. Material conflict: live reservation text says it forbids nothing, whereas the catalog says an exclusive hold; the proposal follows the catalog and flags that mismatch. Live main is not the task branch’s pinned source revision.

### https://github.com/shady2k/madarch/blob/main/docs/vision/architecture-talk-2026-11-01.md
- HTTP/access result: `200`; final URL: https://github.com/shady2k/madarch/blob/main/docs/vision/architecture-talk-2026-11-01.md; accessed 2026-11-12.
- Public live main discussion read. Branch layers use merge-base; verified marks carry at merge subject to reconciliation. Lane C/B/A wording was not found; no claim that this page proves those lane semantics.

### https://glossary.istqb.org/en_US/term/acceptance-criteria
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/acceptance-criteria; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/acceptance-testing
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/acceptance-testing; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/change-request
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/change-request; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/defect
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/defect; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/epic
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/epic; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/impact-analysis
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/impact-analysis; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/review
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/review; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/test-evidence
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/test-evidence; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://glossary.istqb.org/en_US/term/user-story
- HTTP/access result: `200`; final URL: https://glossary.istqb.org/en_US/term/user-story; accessed 2026-11-12.
- HTTP200 returned only JavaScript application shell (ISTQB Glossary title; no term definition). Term content NOT read. Proposal follows the full catalog definition; related substantive sources used when available. Do not treat HTTP200 as evidence of reading this term.

### https://openai.github.io/openai-agents-python/tracing/
- HTTP/access result: `200`; final URL: https://openai.github.io/openai-agents-python/tracing/; accessed 2026-11-12.
- Public tracing guide read. Workflow traces contain spans with start/end times and operation records; LLM calls/tool calls/handoffs are traced. Catalog lifecycle-step cost/accounting is a product adaptation, not an exact SDK kind.

### https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- HTTP/access result: `200`; final URL: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/; accessed 2026-11-12.
- Public URL is a moved notice, not the original normative spans convention. It points to the new GenAI repository; no claim to have read the removed convention at this URL. OpenAI tracing provides the substantive operation-record reading.

### https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
- HTTP/access result: `200`; final URL: https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/; accessed 2026-11-12.
- Public VCS registry read from cached HTML. vcs.change.id identifies a proposed PR/MR/changelist in repository scope, and state tracks open/closed/merged. It does not provide a complete review entity model; GitHub review docs supply substantive review semantics.

### https://pubs.opengroup.org/architecture/archimate32-doc/
- HTTP/access result: `200`; final URL: https://identity.opengroup.org/authenticationendpoint/login.do?client_id=J1MVMsuCgZIuKgLLpn596BZ4Kf0a&code_challenge=pEW8zL84dsVDCx67CCm7ZbIK76HahRaCsr1qfpgl2DY&code_challenge_method=S256&commonAuthCallerPath=%2Foauth2%2Fauthorize&forceAuth=false&nonce=Rh3ECg4YHmRq6Md1MhhpFkwDcdT1CYgBQRw4J4TDmBA&passiveAuth=false&redirect_uri=https%3A%2F%2Fpubs.opengroup.org%2Fsso_redirect_uri&response_type=code&scope=openid&state=CuhI91PKnrzKAwDLlFHzchCNDRc&sessionDataKey=eb52e9fa-c3fa-4c5c-bf99-9bd6489d9fcc&relyingParty=J1MVMsuCgZIuKgLLpn596BZ4Kf0a&type=oidc&sp=Pubs&spId=64869a4a-8845-47af-a1b5-c4fe479b3d1e&isSaaSApp=false&authenticators=BasicAuthenticator%3ALOCAL&spId=64869a4a-8845-47af-a1b5-c4fe479b3d1e; accessed 2026-11-12.
- HTTP200 but redirected content is Open Group sign-in, NOT the ArchiMate standard. No standard chapter read. ArchiMate proposals use catalog definitions and the explicit task direction driver -> assessment -> goal; exact mandatory inputs are design judgments, not asserted normative rules.

### https://scrumguides.org/scrum-guide.html
- HTTP/access result: `200`; final URL: https://scrumguides.org/scrum-guide.html; accessed 2026-11-12.
- Substantive 2020 Scrum Guide read from shared cached text. Product Goal is future state and the rest of the backlog emerges to fulfill it; DoD describes required product quality, and an increment is born when work meets it. Scrum roles carry accountabilities. Increments are not needed to first define DoD or plan a sprint.

### https://standards.ieee.org/ieee/29148/6937/
- HTTP/access result: `200`; final URL: https://standards.ieee.org/ieee/29148/6937/; accessed 2026-11-12.
- Public abstract read; purchase/subscription page, full standard NOT read. Abstract describes requirements processes/products, good requirements and requirements information-item content. Goal/scenario prerequisites and aggregation direction are catalog-informed proposals rather than a normative IEEE dependency requirement.

### https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-subtask/
- HTTP/access result: `200`; final URL: https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-subtask/; accessed 2026-11-12.
- Public work-item guidance read (large navigation-heavy page). Work items can be created independently and subtasks refine scope; no basis to require an epic for all standalone catalog tasks.

### https://support.atlassian.com/jira-software-cloud/docs/issue-types-how-do-team-managed-and-company-managed-projects-differ/
- HTTP/access result: `200`; final URL: https://support.atlassian.com/jira-software-cloud/docs/issue-types-how-do-team-managed-and-company-managed-projects-differ/; accessed 2026-11-12.
- HTTP200 public page read, but mostly navigation/space-type guidance and no substantive Bug definition found in extracted text. It does not prove the catalog defect/bug distinction. That distinction is taken from catalog definitions.

### https://support.atlassian.com/jira-software-cloud/docs/what-is-an-epic/
- HTTP/access result: `200`; final URL: https://support.atlassian.com/jira-software-cloud/docs/what-is-an-epic/; accessed 2026-11-12.
- Public substantive epic guidance read. An epic is a large body of work, essentially a large story, refined into smaller stories across sprints. Catalog stage as a bounded responsibility unit is product-specific, not a Jira standard type.

### https://svnbook.red-bean.com/en/1.8/svn.advanced.locking.html
- HTTP/access result: `200`; final URL: https://svnbook.red-bean.com/en/1.8/svn.advanced.locking.html; accessed 2026-11-12.
- Substantive book section read. A lock grants one user exclusive right to change a versioned file, with lock owner and token. Page warns it is a work-in-progress. It supports the catalog hold analogy, but conflicts with live madarch decision’s optimistic reservation semantics.

### https://www.atlassian.com/agile/product-management/product-roadmaps
- HTTP/access result: `200`; final URL: https://www.atlassian.com/agile/product-management/product-roadmaps; accessed 2026-11-12.
- Public roadmap guide read. Roadmap outlines vision, direction, priorities, progress over time and links daily work to business objectives. It does not mandate a released version before planning; roadmap/release-plan order is a catalog-informed planning choice.

### https://www.nngroup.com/articles/contextual-inquiry/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/contextual-inquiry/; accessed 2026-11-12.
- Substantive public article read. Natural-context observation and interview with knowledgeable participants; Focus means understanding study purpose and information sought before a session.

### https://www.nngroup.com/articles/journey-mapping-101/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/journey-mapping-101/; accessed 2026-11-12.
- Substantive public article read. Journey frames actor, scenario/expectations, phases, actions/thoughts/emotions and opportunities. Journey’s scenario is linked to actor goal/need; touchpoints are within the framed experience. Maps may be real or anticipated.

### https://www.nngroup.com/articles/persona/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/persona/; accessed 2026-11-12.
- Substantive public article read. Persona is fictional but realistic target-user representation synthesized from concrete research; therefore findings precede persona, not vice versa.

### https://www.nngroup.com/articles/usability-testing-101/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/usability-testing-101/; accessed 2026-11-12.
- Substantive public article read. Facilitator asks participant to perform tasks with interfaces and observes behavior/feedback; problems emerge from the session. Task flow precedes session and session precedes finding.

### https://www.nngroup.com/articles/user-interviews/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/user-interviews/; accessed 2026-11-12.
- Substantive public article read. Interview should have concise research goals/questions that influence the guide; it yields insights about experiences, challenges and needs.

### https://www.nngroup.com/articles/ux-research-cheat-sheet/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/ux-research-cheat-sheet/; accessed 2026-11-12.
- Substantive public article read. Research can happen throughout discovery/explore/test/listen; methods produce data and insights. It does not require every method per finding, hence no all-method conjunction in dependencies.

### https://www.nngroup.com/articles/which-ux-research-methods/
- HTTP/access result: `200`; final URL: https://www.nngroup.com/articles/which-ux-research-methods/; accessed 2026-11-12.
- Substantive public article read. Method choice depends on questions, qualitative/quantitative and attitudinal/behavioral distinctions; surveys collect categorized attitudes and self-reported data. Methods are alternatives, not universally conjunctive prerequisites.

### https://www.omg.org/spec/BMM/
- HTTP/access result: `200`; final URL: https://www.omg.org/spec/BMM/; accessed 2026-11-12.
- Public OMG version landing read. BMM structures development, communication and management of business plans. Also fetched linked 1.3 PDF successfully (200, 1,481,802 bytes), but local pdftotext unavailable; normative PDF content NOT extracted/read and not used as if read.

### https://www.omg.org/spec/SACM/
- HTTP/access result: `200`; final URL: https://www.omg.org/spec/SACM/; accessed 2026-11-12.
- Public OMG specification overview read, not full normative model. It explicitly defines assurance case as auditable claims, arguments and evidence supporting satisfaction of requirements. Landing is currently 2.4 beta; it does not establish catalog requirement-baseline/change types as SACM classes.

### https://www.w3.org/TR/vocab-org/
- HTTP/access result: `200`; final URL: https://www.w3.org/TR/vocab-org/; accessed 2026-11-12.
- Full public W3C Recommendation read relevant sections 2.1/2.2 and 5.2/5.3. Organization is collective with shared purpose; OrganizationalUnit needs larger organization context; Role is abstract function, Membership is n-ary Agent/Organization/Role with interval. Organization/Role/Agent precede membership records, not the inverse.

### https://www.whatmatters.com/faqs/okr-meaning-definition-example
- HTTP/access result: `200`; final URL: https://www.whatmatters.com/faqs/okr-meaning-definition-example; accessed 2026-11-12.
- Substantive public OKR article read. Objective states what to achieve; key results benchmark and monitor progress and are measurable/verifiable. Objective/goal distinction is catalog-specific; key results are not prerequisite contents of objective identity.

## Selected substantive passages inspected

### https://www.w3.org/TR/vocab-org/
A collection of people: ve. The core class in the ontology
  is org:Organization which is
  intended to be applicable to a very broad range of organizations. It
  represents a collection of people organized together into a  
  community or other social, commercial or political structure. The group 
  has some common purpose or reason for existence which goes beyond the 
  set of people belonging to it. An organization may itself be able to
  act as an agent. We distinguish a particular sub-class of
  organization org:FormalOrganization to indicate organizations that are recognized in the world at large, in 
  particular in legal jurisdictions, with associated rights and 
  responsibilities. Examples include a corporation, charity, government or
  church. The ontology then supports the notion of organizations being
  composed of other organizations in some hierar
Represents an n-ary: ertyOf: org:memberOf 5.3.4 Class: Membership Indicates the nature of an Agent's membership of an organization. RDFS Class: org:Membership Usage note: Represents an n-ary relationship between an Agent, an Organization and a 
Role. It is possible to directly indicate membership, independent of the
 specific Role, through use of the org:memberOf property. Property: member Indicates the Person (or other Agent including Organization) involved in the Membership relationship. RDF Property: org:member Domain: org:Membership Range: foaf:Agent Type: owl:FunctionalProperty Usage note: Inverse of org:hasMembership Property: organization Indicates the organization in which the Agent is a member. RDF Property: org:organization Domain: org:Membership Range: org:Organization Type: owl:FunctionalProperty Property: role Indicates the Role that the Agent pl
An Organization such: y and it is recommended to use the GoodRelations vocabulary to denote Business classifications such as DUNS or NAICS. 5.2.3 Class: OrganizationalUnit An Organization such as a department or support unit which is part of some 
larger Organization and only has full recognition within the 
context of that Organization. In particular the unit would not be
regarded as a legal entity in its own right. RDFS Class: org:OrganizationalUnit subClassOf: org:Organization Usage note: Units can be large and complex containing other Units. Alternative names: Department Property: hasUnit Indicates a unit which is part of this Organization, e.g. a Department within a larger Organization. RDF Property: org:hasUnit Domain: org:Organization Range: org:OrganizationalUnit subPropertyOf: org:hasSubOrganization Usage note: Inverse of org:unitOf . Property: unitOf
Denotes a role: y the interval representation is left open, however as an informative note the use of time:Interval from [ OWL-TIME ] is suggested. 5.3.5 Class: Role Denotes a role that a Person or other Agent can take in an 
organization. Instances of this class describe the abstract role; to 
denote a specific instance of a person playing that role in a specific 
organization use an instance of org:Membership . RDFS Class: org:Role subClassOf: skos:Concept Usage note: It is 
common for roles to be arranged in some taxonomic structure and we use 
SKOS to represent that. The normal SKOS lexical properties should be 
used when labelling the Role. Additional descriptive properties for the 
Role, such as a Salary band, may be added by extension vocabularies. Property: roleProperty This is a metalevel property which is used to annotate a org:Role instance wi

### https://scrumguides.org/scrum-guide.html
Commitment: Product Goal: ll be doing the work are responsible for the
sizing. The Product Owner may influence the Developers by helping them
understand and select trade-offs. Commitment: Product Goal The Product Goal describes a future state of the product which can serve
as a target for the Scrum Team to plan against. The Product Goal is in
the Product Backlog. The rest of the Product Backlog emerges to define
“what” will fulfill the Product Goal. A product is a vehicle to deliver value. It has a clear boundary,
known stakeholders, well-defined users or customers. A product could
be a service, a physical product, or something more abstract. The Product Goal is the long-term objective for the Scrum Team. They
must fulfill (or abandon) one objective before taking on the next. Sprint Backlog The Sprint Backlog is composed of the Sprint Goal (why), the set of
Produc
Commitment: Definition of Done: t Review should never be considered a gate to
releasing value. Work cannot be considered part of an Increment unless it meets the
Definition of Done. Commitment: Definition of Done The Definition of Done is a formal description of the state of the
Increment when it meets the quality measures required for the product. The moment a Product Backlog item meets the Definition of Done, an
Increment is born. The Definition of Done creates transparency by providing everyone a
shared understanding of what work was completed as part of the
Increment. If a Product Backlog item does not meet the Definition of
Done, it cannot be released or even presented at the Sprint Review.
Instead, it returns to the Product Backlog for future consideration. If the Definition of Done for an increment is part of the standards of
the organization, all Scrum Teams mus
The Scrum Team consists: ansparency, inspection, and adaptation come to life
building trust. Scrum Team The fundamental unit of Scrum is a small team of people, a Scrum Team.
The Scrum Team consists of one Scrum Master, one Product Owner, and
Developers. Within a Scrum Team, there are no sub-teams or hierarchies.
It is a cohesive unit of professionals focused on one objective at a
time, the Product Goal. Scrum Teams are cross-functional, meaning the members have all the
skills necessary to create value each Sprint. They are also
self-managing, meaning they internally decide who does what, when, and
how. The Scrum Team is small enough to remain nimble and large enough to
complete significant work within a Sprint, typically 10 or fewer people.
In general, we have found that smaller teams communicate better and are
more productive. If Scrum Teams become too large, t
Product Backlog is: itly communicating the Product Goal; Creating and clearly communicating Product Backlog items; Ordering Product Backlog items; and, Ensuring that the Product Backlog is transparent, visible and
understood. The Product Owner may do the above work or may delegate the
responsibility to others. Regardless, the Product Owner remains
accountable. For Product Owners to succeed, the entire organization must respect
their decisions. These decisions are visible in the content and ordering
of the Product Backlog, and through the inspectable Increment at the
Sprint Review. The Product Owner is one person, not a committee. The Product Owner may
represent the needs of many stakeholders in the Product Backlog. Those
wanting to change the Product Backlog can do so by trying to convince
the Product Owner. Scrum Master The Scrum Master is accountable for e

### https://www.whatmatters.com/faqs/okr-meaning-definition-example
An Objective:  started on creating OKRs for yourself or your organization? Take our OKRs Explained course! Objectives and Key Results: The OKR Framework Objectives An Objective is simply what is to be achieved, no more and no less. By definition, Objectives are significant, concrete, action oriented, and (ideally) inspirational. When properly designed and deployed, theyâre a vaccine against fuzzy thinking and ineffective execution. Key Results Key Results benchmark and monitor how we get to the Objective. Effective KRs are specific, time-bound, and aggressive yet realistic. Most of all, they are measurable and verifiable. You either meet a Key Resultâs requirements or you donât â there is no gray area, no room for doubt. At the end of the designated period, typically a quarter , we do a regular check and grade the Key Results as fulfilled or no
Key Results:  Committing Education Government What is an OKR? Definition and Examples Author: Ryan Panchadsaram Share: Summary âOKRâ stands for Objectives and Key Results . OKRs are an effective goal-setting and leadership tool for communicating what you want to accomplish and what milestones youâll need to meet in order to accomplish it. OKRs are used by some of the worldâs leading organizations to set and enact their strategies. In this article weâll define an OKR, look at how theyâre used and provide some examples of OKRs. What is an OKR? OKR Meaning, Definition & Examples OKRs stand for Objectives and Key Results , a collaborative goal-setting methodology used by teams and individuals to set challenging, ambitious goals with measurable results. OKRs are how you track progress, create alignment, and encourage engagement around measurabl

### https://www.nngroup.com/articles/persona/
concrete research: t can be easier said than done when users feel like generic and undefined entities. Personas create a memorable representation of real users based on concrete research. In This Article: Definition of a Persona Creating Personas Why Personas? Ongoing Benefits of Personas Definition of a Persona A persona is a fictional, yet realistic, description of a typical or target user of the product. Personas help product teams empathize with users. Personas are powerful UX deliverables that take advantage of the human tendency to be more captivated by concrete instances than generalizations. Where user groups or market segments are often presented as number ranges for various attributes, personas synthesize that data into a single, fictional user. Example of a persona, targeted at helping design the About and Careers content for a company website An
Creating Personas: and undefined entities. Personas create a memorable representation of real users based on concrete research. In This Article: Definition of a Persona Creating Personas Why Personas? Ongoing Benefits of Personas Definition of a Persona A persona is a fictional, yet realistic, description of a typical or target user of the product. Personas help product teams empathize with users. Personas are powerful UX deliverables that take advantage of the human tendency to be more captivated by concrete instances than generalizations. Where user groups or market segments are often presented as number ranges for various attributes, personas synthesize that data into a single, fictional user. Example of a persona, targeted at helping design the About and Careers content for a company website An effective persona will feel like a living user and contain 

### https://www.nngroup.com/articles/which-ux-research-methods/
Surveys: about users' mental model of an information space and can help determine the best information architecture for your product, application, or website. Surveys measure and categorize attitudes or collect self-reported data that can help track or discover important issues to address. Focus groups tend to be less useful for usability purposes, for a variety of reasons, but can provide a top-of-mind view of what people think about a brand or product concept in a group setting. On the other end of this dimension, methods that focus mostly on behavior seek to understand "what people do" with the product or service in question. For example A/B testing presents changes to a site's design to random samples of site visitors but attempts to hold all else constant, in order to see the effect of different site-design choices on behavior, while eyetrack
Attitudinal:  only use one or two methods that they are most familiar with. The key question is what to use when. In This Article: Three-Dimensional Framework The Attitudinal vs. Behavioral Dimension The Qualitative vs. Quantitative Dimension The Context of Product Use Phases of Product Development (the Time Dimension) Art or Science? 20 UX Methods in Brief Three-Dimensional Framework To better understand when to use which method, it is helpful to view them along a 3-dimensional framework with the following axes: Attitudinal vs. Behavioral Qualitative vs. Quantitative Context of Use The following chart illustrates where 20 popular methods appear along these dimensions: Each dimension provides a way to distinguish among studies in terms of the questions they answer and the purposes they are most suited for. The methods placed in the middle of the quant

### https://www.nngroup.com/articles/user-interviews/
goals: hink of an interview as a research study, not a sales session or an informal conversation. Like any research study, an interview should have research goals (or research questions). Goals that are too broad (like learning about users ) can result in interviews that fail to produce useful or actionable insights. Examples of reasonable research goals include: What causes customers to consider and try our product? What are the highs and lows of their experience? How much knowledge of the process do users have? What makes users abandon the product? A concise, concrete set of goals that relate to your target users’ specific behaviors or attitudes can help you gather helpful and actionable insights. These goals will influence the questions you’ll ask in your interviews. 2. Prepare a Guide An interview guide is used to direct the conversation and
research questions:  interview as a research study, not a sales session or an informal conversation. Like any research study, an interview should have research goals (or research questions). Goals that are too broad (like learning about users ) can result in interviews that fail to produce useful or actionable insights. Examples of reasonable research goals include: What causes customers to consider and try our product? What are the highs and lows of their experience? How much knowledge of the process do users have? What makes users abandon the product? A concise, concrete set of goals that relate to your target users’ specific behaviors or attitudes can help you gather helpful and actionable insights. These goals will influence the questions you’ll ask in your interviews. 2. Prepare a Guide An interview guide is used to direct the conversation and help you 

### https://www.nngroup.com/articles/contextual-inquiry/
Focus: tion. The researcher should develop a comprehensive and shared interpretation for all important aspects of the work, aided by feedback from the user. Focus . The researcher should understand the purpose of the research project and what information should be sought. This understanding guides the observation and the interviews during sessions. 4-Part Session Structure Select participants that are uniquely qualified and knowledgeable in the area you need to understand. Then, use the following 4-part structure as a template to guide your approach. 1. The primer The primer is meant to ease the participant into the session. Starting casually allows your participant to become comfortable with you and learn what to expect from the session. Introduce yourself and take some time upfront to build rapport with your participant. Indicate what you hope
context: Contextual Inquiry: Inspire Design by Observing and Interviewing Users in Their Context - NN/G Skip to content 8 Contextual Inquiry: Inspire Design by Observing and Interviewing Users in Their Context Kim Flaherty Kim Flaherty December 6, 2020 2020-12-06 Share Email article Share on LinkedIn Share on Twitter Summary: Through observation and collaborative interpretation, contextual inquiry uncovers hidden insights about customer’s work that may not be available through other research methods. In our collection of UX-research methodologies , contextual inquiry is essential. Contextual inquiry is a type of ethnographic field study that involves in-depth observation and interviews of a small sam

### https://www.nngroup.com/articles/usability-testing-101/
Tasks: popular UX-research methodology. In a usability-testing session, a researcher (called a “facilitator” or a “moderator”) asks a participant to perform tasks, usually using one or more specific user interfaces. While the participant completes each task, the researcher observes the participant’s behavior and listens for feedback. In This Article: Why Usability Test? Elements of Usability Testing Types of Usability Testing Cost of Usability Testing NN/g Resources for Usability Testing Why Usability Test? The goals of usability testing vary by study, but they usually include: Identifying problems in the design of the product or service Uncovering opportunities to improve Learning about the target user’s behavior and preferences Usability testing helps us to uncover problems, discover opportunities, and learn about users. Why do we need to do u
Participant: ed user testing ) is a popular UX-research methodology. In a usability-testing session, a researcher (called a “facilitator” or a “moderator”) asks a participant to perform tasks, usually using one or more specific user interfaces. While the participant completes each task, the researcher observes the participant’s behavior and listens for feedback. In This Article: Why Usability Test? Elements of Usability Testing Types of Usability Testing Cost of Usability Testing NN/g Resources for Usability Testing Why Usability Test? The goals of usability testing vary by study, but they usually include: Identifying problems in the design of the product or service Uncovering opportunities to improve Learning about the target user’s behavior and preferences Usability testing helps us to uncover problems, discover opportunities, and learn about users.

### https://cucumber.io/docs/gherkin/reference/
The purpose of the Rule: rm of Markdown - formatters including the official HTML formatter support this. Rule ​ The (optional) Rule keyword has been part of Gherkin since v6. The purpose of the Rule keyword is to represent one business rule that should be implemented.
It provides additional information for a feature.
A Rule is used to group together several scenarios
that belong to this business rule . A Rule should contain one or more scenarios that illustrate the particular rule. For example: # -- FILE: features/gherkin.rule_example.feature Feature: Highlander Rule: There can be only One Example: Only One -- More than one alive Given there are 3 ninjas And there are more than one ninja alive When 2 ninjas meet, they will fight Then one ninja dies (but not me) And there is one ninja less alive Example: Only One -- One alive Given there is only 1 ninja alive Then
The purpose of the Feature: Tags) # (Comments) Localisation Gherkin is localised for many spoken languages ; each has their own localised equivalent of these keywords. Feature ​ The purpose of the Feature keyword is to provide a high-level description
of a software feature, and to group related scenarios. The first primary keyword in a Gherkin document must always be Feature , followed
by a : and a short text that describes the feature. You can add free-form text underneath Feature to add more description. These description lines are ignored by Cucumber at runtime, but are available for reporting (they are included by reporting tools like the official HTML formatter). Feature: Guess the word The word guess game is a turn-based game for two players. The Maker makes a word for the Breaker to guess. The game is over when the Breaker guesses the Maker's word. Example: M

### https://www.atlassian.com/agile/product-management/product-roadmaps
priorities: lders using customizable, interactive roadmaps. Use template Key Takeaways A product roadmap is a strategic plan that outlines the vision, direction, priorities, and progress of a product over time. Roadmaps align teams and stakeholders around short and long-term goals, linking daily work to business objectives. Effective roadmaps are clear and are regularly updated to reflect changing priorities. Create and maintain a product roadmap to communicate strategy, track progress, and drive stakeholder alignment. A product roadmap is essential to any product strategy because it communicates how short-term efforts match long-term business goals. Understanding the role of a roadmap—and how to create a great one—is key to keeping everyone on your team headed in the same direction. Try Jira Product Discovery What is a product roadmap? A product roa
releases: [not found]

### https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-subtask/
Subtasks: a work item's details Configure field layout in the work item Copy a work item layout to other spaces Customize the child work item table Choose when subtasks and linked work items have a strikethrough Create and manage synced blocks Create work items with Rovo Use block templates in Jira Work on and progress your work items Log time on a work item Estimate a work item Pin a field to the top of a work item Markdown and keyboard shortcuts Flag a work item Rank a work item Schedule a work item Transition a work item Link work items Clone a work item Watch, share and comment on a Jira work item Add an attachment to a work item Delete an attachment in a work item Use custom emojis to help describe a work item Download all attachments in the attachments panel Switch between the strip and list view for attachments Download an attachment from a 
break down: [not found]

### https://support.atlassian.com/jira-software-cloud/docs/issue-types-how-do-team-managed-and-company-managed-projects-differ/
Bug: [not found]
Task: ra How legal teams use Jira space templates How to use Jira for process management Use business spaces for project management Use business spaces for task management Use Jira business projects for finance projects Use Jira business projects for marketing projects Use Jira for HR projects Use Jira for operations spaces Use Jira for sales teams Use Docs in Jira Cloud Set up Docs in Jira What is the Docs feature? Use Jira Cloud with Microsoft Teams Integrate Jira Cloud and Microsoft Teams Get started with Jira Cloud and Microsoft Teams Mention Jira in Microsoft Teams to manage work Create and update Jira work from Microsoft Teams Add Jira Cloud tabs to teams, channels, and meetings Get Jira notifications in Microsoft Teams Use Jira Cloud with Slack Integrate Jira Cloud and Slack Get started with Jira Cloud and Slack Mention Jira in Slack to 

### https://svnbook.red-bean.com/en/1.8/svn.advanced.locking.html
exclusive: ems. Subversion's locking feature exists ultimately to minimize
      wasted time and effort.  By allowing a user to programmatically
      claim the exclusive right to change a file in the repository,
      that user can be reasonably confident that any energy he invests
      on unmergeable changes won't be wastedâhis commit of those
      changes will succeed.  Also, because Subversion communicates to
      other users that serialization is in effect for a particular
      versioned object, those users can reasonably expect that the
      object is about to be changed by someone else.  They, too, can
      then avoid wasting their time and energy on unmergeable changes
      that won't be committable due to eventual
      out-of-dateness. When referring to Subversion's locking feature, one is
      actually talking about a fairly div
lock owner: ion repository, a lock is a piece of metadata that
        grants exclusive access to one user to change a file.  This
        user is said to be the lock owner .
        Each lock also has a unique identifier, typically a long
        string of characters, known as the lock
        token .  The repository manages locks, ultimately
        handling their creation, enforcement, and removal.  If any
        commit transaction attempts to modify or delete a locked file
        (or delete one of the parent directories of the file), the
        repository will demand two pieces of informationâthat
        the client performing the commit be authenticated as the lock
        owner, and that the lock token has been provided as part of
        the commit process as a form of proof that the client knows which
        lock it is using. To demonst

### https://github.com/shady2k/madarch/blob/main/docs/vision/architecture-talk-2026-11-01.md
lane: [not found]
merge: ources. Update by commit (owner: «по коммиту»). Every branch and worktree, not only the default
branch: a branch layer over the default branch at the merge-base, static facts for the files
the branch changes (uncommitted worktree files re-read per file on an MCP query); agent
verification also runs in the branch on its commits, top down from the highest node the
change touched, batched in a window, with the branch workflow's own budget; at merge the
branch's verified marks and corrections carry over without re-verification, except what the
default branch changed meanwhile (the same commit-time reconciliation with both sides' notes).
The branch layer never writes the default branch's history. Owner: «А почему только по
основной ветке? А как же наш граф будет помогать агенту в worktree?» / «статические проверки в
worktree будет недостаточно

### https://openai.github.io/openai-agents-python/tracing/
span: nConfig.tracing_disabled to True Tracing is unavailable for organizations that use OpenAI's APIs under a Zero Data Retention (ZDR) policy. Traces and spans Traces represent a single end-to-end operation of a "workflow". They're composed of Spans. Traces have the following properties: workflow_name : This is the name of the logical workflow or app. For example "Code generation" or "Customer service". trace_id : A unique ID for the trace. Automatically generated if you don't pass one. Must have the format trace_<32_alphanumeric> . group_id : Optional group ID, to link multiple traces from the same conversation. For example, you might use a chat thread ID. disabled : If True, the trace will not be recorded. metadata : Optional metadata for the trace. Spans represent operations that have a start and end time. Spans have: started_at and ended_
handoff: ntent Tracing The Agents SDK includes built-in tracing, collecting a comprehensive record of events during an agent run: LLM generations, tool calls, handoffs, guardrails, and even custom events that occur. Using the Traces dashboard , you can debug, visualize, and monitor your workflows during development and in production. Note Tracing is enabled by default. You can disable it in three common ways: You can globally disable tracing by setting the env var OPENAI_AGENTS_DISABLE_TRACING=1 You can globally disable tracing in code with set_tracing_disabled(True) You can disable tracing for a single run by setting agents.run.RunConfig.tracing_disabled to True Tracing is unavailable for organizations that use OpenAI's APIs under a Zero Data Retention (ZDR) policy. Traces and spans Traces represent a single end-to-end operation of a "workflow". 

---

## Review batch 1

# Scope and interpretation

Task: madarch-64o5.28. Proposal only; no repository files edited. Access date: 2026-11-12.
All 105 YAML files in architecture, common, design, documentation and information were read, including definitions, English descriptions and extraction fields. The entire supplied catalog was loaded to resolve exact canonical IDs. Parent will translate canonical concept IDs to authoritative basename dependency names using /tmp/derives-id-to-name.json.

Dependencies express nearest meaning-bearing inputs, not every relation or inverse whole/part. Vocabulary schemas can be roots even when their eventual instances attach to other entities. Root reasons are individual in JSON. Flat lists cannot express alternatives (screen OR UI component, any entity kind, any evaluation subject); this proposal avoids pretending all alternatives are mandatory. No mutation or repository checks apply to this research-only proposal.

## Review concerns

- ISO URL is blocked (403); no full/paywalled ISO 42010 text read. Description/view choices remain catalog-grounded rather than claims of normative ISO order.
- HAL returns anti-bot challenge; CRDT paper not read. ISTQB definition URL returns JS application shell; defect definition not claimed read. OTel old gen-AI URLs return moved-page notices; not current detailed conventions.
- UML and BPMN landing pages read and PDFs downloaded, but full-document extraction was stopped after several minutes; focused extraction recovered first 30 PDF pages (front matter and table of contents), not the substantive state/process chapters. No further extraction attempted. Do not claim full UML/BPMN specification read.
- Generic attachments (comment, time entry, external reference, operation, request, snapshot) are primitive roots because they can attach to any subject or bootstrap it. This is not a claim that an attachment instance can omit its subject.
- Backstage resource, technology, atomic token, locale, source message, asset, UI component and schema vocabulary roots avoid making their consumers prerequisites.
- The YAML explicitly says design frame targets a screen or component; common product scope is used instead of incorrectly forcing both alternatives. EARL evaluations require criterion but do not force screen/ACT because subjects and procedures vary.
- Domain factory accepts aggregates OR other complex objects; it depends on bounded model context, not a mandatory aggregate.
- A documented known issue may be intentional limitation, so no mandatory test-defect edge.
- Generic wiki finding/dismissal has no exact generic finding kind. Proposed dismissal uses the document whose place/identity is cited; do not substitute a security-only finding kind.
- Cross-batch global DAG and transitive reduction must be checked by parent, especially glossary/document/code extraction edges. This batch alone is acyclic with no unknown IDs.

## Source access and relevant findings

HTTP 200 alone is not treated as proof of substantive access. The entries below distinguish full text, landing pages, notices, and blocked shells. Shared cache was read without refetch where another worker had already fetched a standard. Sources support concept meanings; ordering is an explicit catalog design judgment, not something every standard prescribes.
### https://arc42.org/overview

Access: HTTP 200 on 2026-11-12; final URL: https://arc42.org/overview/.

Read all twelve-section summaries: goals/constraints precede strategy; static blocks, runtime situations, deployment mapping and crosscutting concepts have distinct purposes. Feedback/enrichment/dismissal workflow is project-specific, not prescribed by this page.

### https://backstage.io/docs/features/software-catalog/system-model

Access: HTTP 200 on 2026-11-12; final URL: https://backstage.io/docs/features/software-catalog/system-model/.

Read Components, APIs, Resources and System/Domain grouping: components are software, APIs their boundaries, resources runtime infrastructure. Resources can be inventoried before consumers; no prerequisite order is mandated by the standard.

### https://c4model.com/abstractions

Access: HTTP 200 on 2026-11-12; final URL: https://c4model.com/abstractions.

Read full abstraction overview: systems contain containers, containers contain components implemented by code. This is containment, not a command to fill every child before a system.

### https://c4model.com/diagrams/deployment

Access: HTTP 200 on 2026-11-12; final URL: https://c4model.com/diagrams/deployment.

Read deployment environment, nodes, infrastructure nodes and instances: deployment maps system/container instances to infrastructure in an environment; support nodes need not run application software.

### https://csrc.nist.gov/pubs/sp/800/209/final

Access: HTTP 200 on 2026-11-12; final URL: https://csrc.nist.gov/pubs/sp/800/209/final.

Public abstract/metadata read, not the full publication. Addresses storage security, protection, isolation, restoration assurance and encryption. It does not establish a catalog-specific snapshot prerequisite.

### https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final

Access: HTTP 200 on 2026-11-12; final URL: https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final.

Public abstract/metadata read, not full guide. Contingency planning includes recovery of information systems; graph snapshot semantics come from the YAML, not this landing page.

### https://cyclonedx.org/docs/1.6/json/

Access: HTTP 200 on 2026-11-12; final URL: https://cyclonedx.org/docs/1.6/json/.

Read data classification, governance and service dataflow-related schema descriptions: classification tags type/sensitivity/value; governance records custodians, stewards and owners. Glossary-named information items are catalog-specific, not a CycloneDX requirement.

### https://diataxis.fr/

Access: HTTP 200 on 2026-11-12; final URL: https://diataxis.fr/.

Read four documentation needs/forms: tutorials support learning, how-to guides tasks, reference information and explanation understanding. A tutorial is not a prerequisite for a how-to; generic document inheritance is not prerequisite order.

### https://doc.anytype.io/anytype/create/links

Access: HTTP 200 on 2026-11-12; final URL: https://doc.anytype.io/anytype/create/links.

Read links/backlinks and relationships between objects. Supports explicit typed connection concept, not universal dependencies on particular endpoint kinds.

### https://doc.anytype.io/anytype/organize/properties

Access: HTTP 200 on 2026-11-12; final URL: https://doc.anytype.io/anytype/organize/properties.

Read properties as structured metadata on objects, reusable across types; this supports primitive field schemas rather than requiring populated instances.

### https://doc.anytype.io/anytype/organize/types

Access: HTTP 200 on 2026-11-12; final URL: https://doc.anytype.io/anytype/organize/types.

Read types as categories/templates for objects with suggested properties. Catalog kind declarations are schemas, not instances of all their dependencies.

### https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue

Access: HTTP 200 on 2026-11-12; final URL: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue.

Read linked issue/PR references and closing keywords: cross-system keys and URLs establish references; a configured architecture integration is not needed for every reference.

### https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests

Access: HTTP 200 on 2026-11-12; final URL: https://docs.github.com/en/pull-requests/reference/pull-requests.

Read pull requests as proposed changes to discuss/review before integration. Creation packages may introduce targets that do not yet exist.

### https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews

Access: HTTP 200 on 2026-11-12; final URL: https://docs.github.com/en/pull-requests/reference/pull-request-reviews.

Read Comment/Approve/Request changes verdicts on proposed changes. Approval needs the proposal, not the other way around.

### https://docs.oasis-open.org/xliff/xliff-core/v2.1/os/xliff-core-v2.1-os.html

Access: HTTP 200 on 2026-11-12; final URL: https://docs.oasis-open.org/xliff/xliff-core/v2.1/os/xliff-core-v2.1-os.html.

Read core file/unit/segment/source/target structures and srcLang/trgLang. Translation interchange combines source units with language context.

### https://endoflife.date/

Access: HTTP 200 on 2026-11-12; final URL: https://endoflife.date/.

Read product/language/framework lifecycle directory. Technology identity and published support lifecycle can be acquired without a product implementation.

### https://gdpr-info.eu/

Access: HTTP 200 on 2026-11-12; final URL: https://gdpr-info.eu/.

Read GDPR structure and communication-related recitals context. This source is not a complete legal basis for separate communications secrecy; no claim that all communications are personal data.

### https://gdpr-info.eu/art-4-gdpr/

Access: HTTP 200 on 2026-11-12; final URL: https://gdpr-info.eu/art-4-gdpr/.

Read Article 4 definitions: personal data relates to an identified/identifiable natural person; processing includes collection, storage, disclosure and destruction.

### https://gdpr-info.eu/art-9-gdpr/

Access: HTTP 200 on 2026-11-12; final URL: https://gdpr-info.eu/art-9-gdpr/.

Read Article 9(1) special categories and exceptions: protected subset concerns racial/ethnic origin, beliefs, union membership, genetics, identifying biometrics, health, sex life/orientation.

### https://git-scm.com/docs/git-show

Access: HTTP 200 on 2026-11-12; final URL: https://git-scm.com/docs/git-show.

Read git-show object/revision:path semantics: source content is grounded in a file object at a revision, supporting file plus commit prerequisites.

### https://github.com/shady2k/madarch/blob/main/docs/decisions/0021-product-repository-contract.md

Access: HTTP 200 on 2026-11-12; final URL: https://github.com/shady2k/madarch/blob/main/docs/decisions/0021-product-repository-contract.md.

Public GitHub source page retrieved. Read repository manifest contract material; local YAML declarations supply exact current kind semantics. Not a normative external standard.

### https://github.com/shady2k/madarch/blob/main/docs/decisions/0033-one-workflow-by-entity-kinds.md

Access: HTTP 200 on 2026-11-12; final URL: https://github.com/shady2k/madarch/blob/main/docs/decisions/0033-one-workflow-by-entity-kinds.md.

Read project decision content: graph walked by kind; authored kinds have one current lifecycle status; pending changes are approved separately. Schema definition order must not create a kind/lifecycle loop.

### https://github.com/shady2k/madarch/blob/main/docs/vision/architecture-talk-2026-11-01.md

Access: HTTP 200 on 2026-11-12; final URL: https://github.com/shady2k/madarch/blob/main/docs/vision/architecture-talk-2026-11-01.md.

Read owner conversation record: verbatim requests are inputs, not rewritten inferred tasks. Requests must remain possible before their desired changes exist.

### https://glossary.istqb.org/en_US/term/defect

Access: HTTP 200 on 2026-11-12; final URL: https://glossary.istqb.org/en_US/term/defect.

HTTP 200 returns a client-rendered application shell, not a substantive defect definition. No claim of reading definition; YAML explicitly includes both defects and limitations, so no mandatory defect edge inferred.

### https://hal.inria.fr/inria-00555588/document

Access: HTTP 200 on 2026-11-12; final URL: https://hal.inria.fr/inria-00555588/document.

HTTP 200 is an Anubis anti-bot challenge, not the cited CRDT paper. Paper not read. Event sourcing alternative and YAML used for primitive operation interpretation.

### https://keepachangelog.com/

Access: HTTP 200 on 2026-11-12; final URL: https://keepachangelog.com/.

HTTP 200 splash only. Followed English version for substantive content.

### https://liquidjs.com/

Access: HTTP 200 on 2026-11-12; final URL: https://liquidjs.com/.

Read template-engine overview: Liquid parsed templates and interpolation generate output; catalog page template target kind supplies context, not already generated pages.

### https://martinfowler.com/eaaDev/EventSourcing.html

Access: HTTP 200 on 2026-11-12; final URL: https://martinfowler.com/eaaDev/EventSourcing.html.

Read capture changes as sequence of events and rebuild state by replay; snapshots optimize reconstruction but are not mandatory before first change.

### https://messageformat.unicode.org/

Access: HTTP 200 on 2026-11-12; final URL: https://messageformat.unicode.org/.

Read MF2 variables, movable interpolation, markup and plural/selection examples. Source message syntax can be authored independently of a concrete screen or target locale.

### https://openai.github.io/openai-agents-python/tracing/

Access: HTTP 200 on 2026-11-12; final URL: https://openai.github.io/openai-agents-python/tracing/.

Read traces/spans collect run events including generation, tools, handoffs and guardrails. Accounting schema is not itself an execution trace.

### https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/

Access: HTTP 200 on 2026-11-12; final URL: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/.

HTTP 200 moved-page notice read; current detailed metrics conventions not claimed read at this old URL. Duration/tokens/cost fields are explicit in YAML.

### https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

Access: HTTP 200 on 2026-11-12; final URL: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/.

HTTP 200 moved-page notice read; detailed span conventions not claimed read at old URL. Trace-schema concepts corroborated by Agents SDK tracing.

### https://scrumguides.org/scrum-guide.html

Access: HTTP 200 on 2026-11-12; final URL: https://scrumguides.org/scrum-guide.html.

Read Scrum Team accountabilities: Product Owner accountable for product value/backlog, Developers create usable increment; responsibility schema may express these roles without requiring Scrum entities.

### https://spdx.github.io/spdx-spec/v3.0.1/model/

Access: HTTP 200 on 2026-11-12; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/.

Read SPDX model index: File is a software artifact identity. Markdown heading section semantics are catalog extraction semantics, not SPDX vocabulary.

### https://spec.openapis.org/oas/v3.1.1.html

Access: HTTP 200 on 2026-11-12; final URL: https://spec.openapis.org/oas/v3.1.1.html.

Read introduction and operation/path/schema structures: machine-readable interface description can generate reference docs without live endpoints.

### https://storybook.js.org/docs/api/csf

Access: HTTP 200 on 2026-11-12; final URL: https://storybook.js.org/docs/api/csf.

Read CSF default export metadata/component and named story exports/args. A story is a particular rendered component state, not the prerequisite of its component.

### https://support.atlassian.com/jira-service-management-cloud/docs/create-an-sla/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-service-management-cloud/docs/create-an-sla/.

Read SLA timing/conditions and goals; work time and waiting time can be measured against generic work items.

### https://support.atlassian.com/jira-service-management-cloud/docs/what-are-service-requests/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-service-management-cloud/docs/what-are-service-requests/.

Read requests as user-raised needs handled by service teams; cannot require resulting changes first.

### https://support.atlassian.com/jira-software-cloud/docs/create-and-edit-workflows-in-team-managed-projects/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/create-and-edit-workflows-in-team-managed-projects/.

Read workflow editor states and moves; states and transitions form workflow, but schema vocabulary must be definable before workflow assembly.

### https://support.atlassian.com/jira-software-cloud/docs/create-edit-and-delete-statuses-in-team-managed-projects/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/create-edit-and-delete-statuses-in-team-managed-projects/.

Read statuses report item state, editable in workflow; distinction between named vocabulary and workflow use avoids containment cycle.

### https://support.atlassian.com/jira-software-cloud/docs/edit-the-assignee-of-an-issue-with-your-keyboard/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/edit-the-assignee-of-an-issue-with-your-keyboard/.

Read assignee is person carrying the work; reusable responsibility schema is distinct from populated assignment.

### https://support.atlassian.com/jira-software-cloud/docs/link-issues/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/link-issues/.

Read work-item links with named relationship and remote web links; link type constrains connection, references do not need a service integration.

### https://support.atlassian.com/jira-software-cloud/docs/log-time-on-an-issue/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/log-time-on-an-issue/.

Read logging work time against an item and estimates/remaining work; catalog extends to any entity and waiting/agent runs.

### https://support.atlassian.com/jira-software-cloud/docs/transition-an-issue/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/transition-an-issue/.

Read moves between statuses and looped actions, conditions/validators; moves require states and events, workflows assemble these moves.

### https://support.atlassian.com/jira-software-cloud/docs/watch-share-and-comment-on-a-work-item/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/watch-share-and-comment-on-a-work-item/.

Read item comments and notifications; remarks are attached to generic subjects, not a specific product domain kind.

### https://support.atlassian.com/jira-software-cloud/docs/what-are-approvals/

Access: HTTP 200 on 2026-11-12; final URL: https://support.atlassian.com/jira-software-cloud/docs/what-are-approvals/.

Read approvers give verdict before workflow progress; proposed work must exist before approval.

### https://unicode.org/reports/tr35/

Access: HTTP 200 on 2026-11-12; final URL: https://unicode.org/reports/tr35/.

Read CLDR introduction and language/locale identifier structure: language, optional script/region/variants and formatting data. Locale vocabulary can precede translations.

### https://www.atlassian.com/software/jira/service-management

Access: HTTP 200 on 2026-11-12; final URL: https://www.atlassian.com/software/jira/service-management.

Read public product overview (marketing, not detailed standard): service requests/support and resolution workflows. Answer requires a request; request need not have a diagnosed defect.

### https://www.designtokens.org/TR/2025.10/format/

Access: HTTP 200 on 2026-11-12; final URL: https://www.designtokens.org/tr/2025.10/format/.

Read token/group definitions, named $value and optional groups. Groups organize token definitions; atomic token can exist before styles/components.

### https://www.designtokens.org/TR/2025.10/resolver/

Access: HTTP 200 on 2026-11-12; final URL: https://www.designtokens.org/tr/2025.10/resolver/.

Read sets, modifiers, contexts and resolution order: chooses alternate token values for themes/sizes/accessibility contexts. A token set need not require a separate token-group entity.

### https://www.domainlanguage.com/ddd/reference/

Access: HTTP 200 on 2026-11-12; final URL: https://www.domainlanguage.com/ddd/reference/.

Read reference landing page, followed free CC-licensed DDD reference PDF for actual definitions and patterns.

### https://www.iso.org/standard/74393.html

Access: HTTP 403 on 2026-11-12; final URL: https://www.iso.org/standard/74393.html.

HTTP 403 Cloudflare challenge. ISO publication and paywalled full standard NOT read. Architecture-description/view rationale is explicitly provisional from YAML; do not present it as verified normative ISO interpretation.

### https://www.nngroup.com/articles/design-systems-101/

Access: HTTP 200 on 2026-11-12; final URL: https://www.nngroup.com/articles/design-systems-101/.

Read design system as shared standards, reusable patterns/components and design language, with adoption approaches. A design frame may target a screen OR component; flat list cannot express that alternative.

### https://www.nngroup.com/articles/usability-testing-101/

Access: HTTP 200 on 2026-11-12; final URL: https://www.nngroup.com/articles/usability-testing-101/.

Read participants completing tasks using interfaces while facilitator observes. Screen purpose follows user task; article is research methodology, not a formal screen metamodel.

### https://www.omg.org/spec/BPMN/

Access: HTTP 200 on 2026-11-12; final URL: https://www.omg.org/spec/BPMN/.

Read specification/version landing page; downloaded 2.0.2 PDF for process/gateway content (extraction status recorded separately).

### https://www.omg.org/spec/BPMN/2.0.2/

Access: HTTP 200 on 2026-11-12; final URL: https://www.omg.org/spec/BPMN/2.0.2/.

Read specification landing page/version and document links; event/transition details additionally depend on YAML and PDF extraction.

### https://www.omg.org/spec/UML/

Access: HTTP 200 on 2026-11-12; final URL: https://www.omg.org/spec/UML/.

Read specification/version landing page; downloaded 2.5.1 PDF for state-machine content (extraction status recorded separately).

### https://www.w3.org/Graphics/SVG/

Access: HTTP 200 on 2026-11-12; final URL: https://www.w3.org/groups/wg/svg/.

Read SVG working-group/format description: scalable vector graphics is an asset representation. It does not imply an existing screen prerequisite for an image asset.

### https://www.w3.org/TR/CSS22/

Access: HTTP 200 on 2026-11-12; final URL: https://www.w3.org/TR/CSS22/.

Read stylesheet introduction: rules govern rendering of structured documents. Catalog adds token references; CSS itself does not require design tokens or reusable components.

### https://www.w3.org/TR/EARL10-Schema/

Access: HTTP 200 on 2026-11-12; final URL: https://www.w3.org/TR/EARL10-Schema/.

Read assertion/assertor/subject/criterion/result model and examples. Subject can be any resource; ACT rule is not required for manual criterion evaluations.

### https://www.w3.org/TR/WCAG22/

Access: HTTP 200 on 2026-11-12; final URL: https://www.w3.org/TR/WCAG22/.

Read success-criterion levels and conformance/claims: criteria are normative vocabulary; a grounded conformance report needs evaluated results, not merely the criteria names.

### https://www.w3.org/TR/act-rules-format/

Access: HTTP 200 on 2026-11-12; final URL: https://www.w3.org/TR/act-rules-format/.

Read rules test requirements, applicability and expectations. Catalog specifically scopes this kind to a success-criterion check; ACT general scope is broader.

### https://www.wipo.int/en/web/trade-secrets

Access: HTTP 200 on 2026-11-12; final URL: https://www.wipo.int/en/web/trade-secrets.

Read commercial value because secret, limited knowledge and reasonable secrecy steps. Trade secret is not necessarily personal data or a single classification level.

### https://keepachangelog.com/en/1.1.0/

Access: HTTP 200 on 2026-11-12; final URL: https://keepachangelog.com/en/1.1.0/.

Read changelog definition (curated, chronologically ordered notable changes for each version), Unreleased section and release dates. Notes of a release need release identity; empty Unreleased heading alone is not filled history.

### https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf

Access: HTTP 200 on 2026-11-12; final URL: https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf.

Downloaded HTTP 200; extracted PDF text. Read bounded context/ubiquitous language, entity identity, value-object attributes, domain events, service, aggregate consistency/root, repositories, factories and context maps. Supports domain-model scope before these elaborations.

## Roots

backstage.resource, practice.technology, practice.comment, practice.external-reference, practice.operation, practice.request, practice.snapshot, practice.time-entry, manifest.accounting, manifest.event, manifest.properties, manifest.responsibility, manifest.statuses, wcag.success-criterion, cldr.locale, unicode-mf2.message, practice.asset, storybook.component, dtcg.design-token, practice.information-classification

---

## Review batch 2

# Prerequisite proposal source review — groups 2

Access date: 2026-11-12. All 32 distinct cited URLs returned HTTP 200; 7 follow-up documents also returned HTTP 200. Read relevant sections, not every page of long specifications. Responses cached under /tmp/derives-standard-cache using SHA-256 URL names. No paywall or access denial encountered. PDF text was extracted in a scratch uv environment, not by installing kernel packages.

## Scope and interpretation

Read all 73 assigned YAML files and full 521-entry supplied catalog (including non-kind catalog entries). Proposal covers all 71 actual kinds in the six assigned groups. Read but excluded everything/none template presets because they are not kinds. Canonical concept IDs appear in the proposal; parent will translate to authoritative filename-based dependency names. Flat lists are conjunctive prerequisites; alternative attachment kinds cannot be represented as OR. Therefore openlineage.facet is an explicitly reasoned root with per-instance attachment validation, rather than incorrectly requiring dataset, job AND run. Independently identifiable stores/endpoints are roots instead of depending on their consumers. No repository files were edited.

## Access and findings

### https://arc42.org/overview
- Access: HTTP 200; 17887 bytes; final URL https://arc42.org/overview/; type text/html; charset=UTF-8.
- Relevant reading: Overview section 11 records risks and technical debts. A source TODO is evidence for possible debt, not automatically the debt itself; the marker needs its source file. Overview does not define TODO extraction.

### https://c4model.com/abstractions
- Access: HTTP 200; 13211 bytes; final URL https://c4model.com/abstractions; type text/html; charset=utf-8.
- Relevant reading: Read the abstraction hierarchy: system -> containers -> components -> code elements. It supports container system scope and distinction between architecture and code. It does not standardise all practice.* file facets, inputs or routes; those derive from each catalog definition.

### https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html
- Access: HTTP 200; 15076 bytes; final URL https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html; type text/html.
- Relevant reading: Read API introduction: S3 REST interface and object access through HTTP. Service identity can precede bucket inventory. Bucket scope follows catalog definition; introduction is not a complete bucket lifecycle specification.

### https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
- Access: HTTP 200; 1630076 bytes; final URL https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html; type text/html.
- Relevant reading: Read logical/physical location and code-flow terminology. Analysis evidence has source locations and flows; SARIF does not itself define catalog sql-build/sql-sink kinds or require a named function for every call.

### https://git-scm.com/docs/git-remote
- Access: HTTP 200; 57227 bytes; final URL https://git-scm.com/docs/git-remote; type text/html; charset=utf-8.
- Relevant reading: Read description and add/get-url/set-url: remote tracks repositories and manages their URLs. Identified repository precedes its configured remote.

### https://html.spec.whatwg.org/multipage/server-sent-events.html
- Access: HTTP 200; 76655 bytes; final URL https://html.spec.whatwg.org/multipage/server-sent-events.html; type text/html; charset=utf-8.
- Relevant reading: Read 9.2 introduction: EventSource targets a server resource; server emits text/event-stream. Provider service precedes the stream; browser consumer and a distinct message schema do not.

### https://json-schema.org/specification
- Access: HTTP 200; 87156 bytes; final URL https://json-schema.org/specification; type text/html; charset=utf-8.
- Relevant reading: Read Core/Validation split and self-describing meta-schemas. Schemas can stand alone; no API, message or dataset consumer is intrinsic.

### https://kubernetes.io/docs/concepts/storage/persistent-volumes/
- Access: HTTP 200; 605906 bytes; final URL https://kubernetes.io/docs/concepts/storage/persistent-volumes/; type text/html; charset=UTF-8.
- Relevant reading: Read PV/PVC lifecycle and volume modes: block and filesystem storage, attachment/mounting to nodes. Catalog specifically narrows block-volume to server-attached device; no Kubernetes cluster edge added to a generic volume.

### https://openlineage.io/docs/spec/object-model
- Access: HTTP 200; 30788 bytes; final URL https://openlineage.io/docs/spec/object-model/; type text/html; charset=utf-8.
- Relevant reading: Read Job, Run, Dataset and facet sections. Job is defined work; Run is an occurrence of Job; Dataset is a discrete collection; facets augment any of the three. Dataset metadata updates exist independently. Facet has alternative attachment kinds, not all three as conjunctive prerequisites. Source does not define an agreed data contract: that mapping is catalog-specific.

### https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
- Access: HTTP 200; 204505 bytes; final URL https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/; type text/html; charset=UTF-8.
- Relevant reading: Read VCS attribute registry: repository URL, refs, changes, change requests and identity fields. Repository context scopes refs and changes. Owner explicitly requires file before commit; this is a catalog filling rule, not a claim imposed by OTel. Authors and tracker references are commit-derived in this catalog.

### https://protobuf.dev/reference/protobuf/proto3-spec/
- Access: HTTP 200; 92229 bytes; final URL https://protobuf.dev/reference/protobuf/proto3-spec/; type text/html; charset=utf-8.
- Relevant reading: Read Service Definition and Proto File grammar: service contains rpc; rpc names request/response message types; proto file permits service at top level. Contract file -> service -> RPC, not service -> contained RPC prerequisite.

### https://scrumguides.org/scrum-guide.html
- Access: HTTP 200; 34943 bytes; final URL https://scrumguides.org/scrum-guide.html; type text/html; charset=utf-8.
- Relevant reading: Read Product/Sprint Backlog portions: backlog items and actionable plan. No Git tracker-task extraction model is defined by Scrum; commit-message dependency follows the explicitly narrower catalog kind.

### https://smpp.org/SMPP_v3_4_Issue1_2.pdf
- Access: HTTP 200; 1182720 bytes; final URL https://smpp.org/SMPP_v3_4_Issue1_2.pdf; type application/pdf.
- Relevant reading: Fetched PDF and extracted text with pypdf via uv scratch environment. Read submit_sm and source_addr/short_message terminology and fields. ESME submits message to SMSC; sender and concatenation are protocol data. No separate generic catalog broker or template prerequisite imposed.

### https://spdx.github.io/spdx-spec/v3.0.1/model/
- Access: HTTP 200; 462 bytes; final URL https://spdx.github.io/spdx-spec/v3.0.1/model/; type text/html; charset=utf-8.
- Relevant reading: Fetched 200 but body is an HTML redirect, not the full model. Followed its Core/Core target below. Directory is treated as repository-scoped by catalog, not inferred as an SPDX requirement.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/
- Access: HTTP 200; 66853 bytes; final URL https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/; type text/html; charset=utf-8.
- Relevant reading: Read relationship vocabulary including dependsOn. SPDX represents relationships but does not prescribe a cycle-extractor fill order; catalog source files establish observed import rings.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/File/
- Access: HTTP 200; 64919 bytes; final URL https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/File/; type text/html; charset=utf-8.
- Relevant reading: Read Summary and Description: any object storing content; fileKind can be directory. Catalog narrows it to VCS file; repository prerequisite comes from that narrower meaning, not generic SPDX conformance.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/Package/
- Access: HTTP 200; 66289 bytes; final URL https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/Package/; type text/html; charset=utf-8.
- Relevant reading: Read Summary/Description: package is a software distribution unit, typically composed of files, with directory, archive and repository snapshot examples. Catalog narrows to manifest folder; do not reverse dependency from file to package.

### https://spec.graphql.org/
- Access: HTTP 200; 3457 bytes; final URL https://spec.graphql.org/; type text/html; charset=utf-8.
- Relevant reading: Version index read; actual stable September2025 specification followed below.

### https://spec.openapis.org/oas/v3.1.1.html
- Access: HTTP 200; 576103 bytes; final URL https://spec.openapis.org/oas/v3.1.1.html; type text/html; charset=utf-8.
- Relevant reading: Read OpenAPI root, Operation and Callback Objects plus webhooks field. Operations occur in a contract; top-level webhooks can be independent of other API calls. Do not force every webhook through a triggering operation.

### https://www.asyncapi.com/docs/reference/specification/v3.0.0
- Access: HTTP 200; 1121101 bytes; final URL https://www.asyncapi.com/docs/reference/specification/v3.0.0; type text/html; charset=UTF-8.
- Relevant reading: Read definitions: channel is addressable organisation of messages; message carries payload/headers; servers and channels/operations are described in an AsyncAPI document. Static channels/contracts do not require deployed brokers. Subscription combines channel and receiving application.

### https://www.domainlanguage.com/ddd/reference/
- Access: HTTP 200; 48315 bytes; final URL https://www.domainlanguage.com/ddd/reference/; type text/html; charset=UTF-8.
- Relevant reading: Landing page describes free DDD definitions/pattern summary, not full book. Followed free PDF below; no claim of reading the book.

### https://www.omg.org/spec/BPMN/
- Access: HTTP 200; 79498 bytes; final URL https://www.omg.org/spec/BPMN/; type text/html;charset=UTF-8.
- Relevant reading: Version landing page read; followed normative 2.0.2 PDF below.

### https://www.postgresql.org/docs/
- Access: HTTP 200; 8897 bytes; final URL https://www.postgresql.org/docs/; type text/html; charset=utf-8.
- Relevant reading: Manual version index read; followed current table/index/alter documentation below.

### https://www.rfc-editor.org/rfc/rfc4253.html
- Access: HTTP 200; 86134 bytes; final URL https://www.rfc-editor.org/rfc/rfc4253.html; type text/html.
- Relevant reading: Read abstract/scope: SSH transport provides encryption, host authentication, integrity over TCP. This is NOT an SFTP file-transfer specification. Thus generic SFTP endpoint dependency remains a catalog interpretation; do not claim RFC4253 defines it.

### https://www.rfc-editor.org/rfc/rfc5322.html
- Access: HTTP 200; 152198 bytes; final URL https://www.rfc-editor.org/rfc/rfc5322.html; type text/html.
- Relevant reading: Read message format scope and originator/destination fields. RFC defines message syntax, not notification placeholders or template resources. Template prerequisite on email follows catalog definition specifically mentioning its template; notification templates can be authored independently.

### https://www.rfc-editor.org/rfc/rfc6455.html
- Access: HTTP 200; 200197 bytes; final URL https://www.rfc-editor.org/rfc/rfc6455.html; type text/html.
- Relevant reading: Read protocol overview: opening handshake and bidirectional message framing with server. Endpoint requires provider context, not an OpenAPI document.

### https://www.rfc-editor.org/rfc/rfc7530.html
- Access: HTTP 200; 871865 bytes; final URL https://www.rfc-editor.org/rfc/rfc7530.html; type text/html.
- Relevant reading: Read NFSv4 abstract: distributed file access with locking, mount integration, security and caching. A named export can precede mounting consumers; managed share does not require an inventoried host-server kind.

### https://www.rfc-editor.org/rfc/rfc8030.html
- Access: HTTP 200; 85923 bytes; final URL https://www.rfc-editor.org/rfc/rfc8030.html; type text/html.
- Relevant reading: Read introduction and architecture roles: application server, push service, user agent and event delivery. Push message belongs to its sender; user-agent subscription is not AsyncAPI topic subscription, so no false channel prerequisite.

### https://www.rfc-editor.org/rfc/rfc9111.html
- Access: HTTP 200; 232630 bytes; final URL https://www.rfc-editor.org/rfc/rfc9111.html; type text/html.
- Relevant reading: Read cache overview/key, storage and freshness rules. Keys are scoped to a cache; cache policy determines storage/reuse/invalidation. RFC focuses HTTP caches, while catalog intentionally generalises to cache stores. Consumer services are not identity prerequisites.

### https://www.w3.org/TR/prov-o/
- Access: HTTP 200; 464179 bytes; final URL https://www.w3.org/TR/prov-o/; type text/html; charset=utf-8.
- Relevant reading: Read starting-point Entity, Activity and Agent definitions. Activity acts on/with entities; agent bears responsibility; entity can be identified before generating activity. Separate identity from optional generation/attribution links to avoid entity/activity cycles.

### https://www.w3.org/TR/vocab-dcat-3/
- Access: HTTP 200; 664822 bytes; final URL https://www.w3.org/TR/vocab-dcat-3/; type text/html; charset=utf-8.
- Relevant reading: Read Catalog, CatalogRecord, Dataset, Distribution and DataService descriptions. CatalogRecord is optional registration metadata; Distribution is accessible dataset representation; service gives data access. Catalog does not depend on its records; records need catalog and described dataset.

### https://www.w3.org/TR/vocab-dqv/
- Access: HTTP 200; 183523 bytes; final URL https://www.w3.org/TR/vocab-dqv/; type text/html; charset=utf-8.
- Relevant reading: Read QualityMeasurement, Metric, computedOn and value. Measurement qualifies a dataset/resource using a metric; no metric kind exists in this catalog. A dataset check is not universally a continuous metric, so measurement does not require check.

### https://spec.graphql.org/September2025/
- Access: HTTP 200; 1112753 bytes; final URL https://spec.graphql.org/September2025/; type text/html; charset=utf-8.
- Relevant reading: Read Schema/Root Operation Types, operation types and validation against type system. Query/mutation/subscription is meaningful against schema types; type declarations can be filled without consuming operations.

### https://www.postgresql.org/docs/current/ddl-basics.html
- Access: HTTP 200; 18973 bytes; final URL https://www.postgresql.org/docs/current/ddl-basics.html; type text/html; charset=utf-8.
- Relevant reading: Read table basics: table rows/columns; each column has name and type; CREATE TABLE identifies table. Table namespace precedes column details.

### https://www.postgresql.org/docs/current/indexes.html
- Access: HTTP 200; 16337 bytes; final URL https://www.postgresql.org/docs/current/indexes.html; type text/html; charset=utf-8.
- Relevant reading: Read index overview and chapter topics including indexes on expressions. Table is the nearest universal index prerequisite; a separate named column is not universal for expression indexes.

### https://www.postgresql.org/docs/current/ddl-alter.html
- Access: HTTP 200; 25752 bytes; final URL https://www.postgresql.org/docs/current/ddl-alter.html; type text/html; charset=utf-8.
- Relevant reading: Read modifying table schemas: adding/removing columns, constraints and names through ALTER TABLE. Migration changes target database/schema, and can create objects that therefore must not all be prerequisites.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Core/
- Access: HTTP 200; 55396 bytes; final URL https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Core/; type text/html; charset=utf-8.
- Relevant reading: Followed redirect; read core model overview of uniquely identified elements and relationships. Does not supply a specific repository-folder fill order.

### https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf
- Access: HTTP 200; 483985 bytes; final URL https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf; type application/pdf.
- Relevant reading: Fetched free PDF, extracted with pypdf. Read Entities p11: identity and lifecycle continuity across changing attributes/representations. Stored data entity refines domain identity; it is not necessarily a relational table.

### https://www.omg.org/spec/BPMN/2.0.2/PDF
- Access: HTTP 200; 7296515 bytes; final URL https://www.omg.org/spec/BPMN/2.0.2/PDF; type application/pdf.
- Relevant reading: Fetched PDF, extracted with pypdf. Read Process p143: flow of organisational activities carrying out work toward common business goal; Task p30 is atomic activity included within process. Goal -> process -> step order; no process dependency on future constituent step inventory.

## Review cautions

- Standards establish semantics, not this project-specific fill graph. practice.* mappings use the individual catalog definition; limitations above distinguish supporting standards from exact authority.
- c4.container uses software-system context rather than reverse dependencies on packages it contains. Check cross-group proposal does not make software-system depend on container.
- database uses its owning container; table/column/index and migration follow without inverse aggregation.
- Commit author and tracker-task intentionally require commit because their catalog definitions describe history-derived records, unlike general people or planned tasks.
- openlineage.job requires dataset for the catalog-specific meaning of consuming/producing data; OpenLineage itself permits more abstract jobs.
- Empty branch histories and other sparse source populations do not change the mandatory owner example commit <- file.
- No mutation testing is applicable: this task produced scratch proposal/evidence only and changed no executable code. Local validation checks exact assigned coverage, catalog IDs, duplicate-free lists, local cycles and local transitive redundancy. Global cross-group cycles require parent integration.

---

## Review batch 3

# Dependency proposal source evidence — security, privacy, suppliers

Task: madarch-64o5.28. Access date: 2026-11-12. Proposal only; no repository files edited.

## Scope and method

All 69 own YAML files were read in full, including definitions, English descriptions, source URLs and relation constraints. The entire 521-entry candidate catalog was read for exact canonical IDs (parent reports 519 actual kinds after excluding two presets; neither belongs to this batch). Proposals use canonical IDs for parent normalization to file-basename names. Dependency arrows mean prerequisite information, not associations or inverse aggregation. Shared source cache: `/tmp/derives-standard-cache` (SHA-256 URL keys). Requests HTTP fetched sources; public HTML parsed with BeautifulSoup. No claim to read linked publications when only abstracts were accessed. No mutation/tests apply to a proposal-only JSON file. Local checks verified all 69 own IDs present once, all references exact, no self edges and no cycles within this batch. Global cross-batch cycles remain parent review responsibility.

## Interpretation and concerns

- A single list cannot express alternative prerequisites. General security assessment findings, SARIF results and vulnerability scans use product scope rather than incorrectly requiring every scan subtype. IAM roles are reusable permission definitions; IAM policies use system scope. Parent should review whether stricter product-specific-only interpretation is desired.
- No blanket product prerequisites for independent normative/classification vocabulary: ASVS, SSDF, CWE, license, algorithms, personal-data/subject categories, purpose. Every root has its own reason in JSON.
- OSCAL catalog -> root; control -> catalog; profile -> control avoids catalog/control aggregation cycles. BOM -> product; SBOM component -> BOM avoids reciprocal BOM aggregation. OSV -> package, not SBOM component, because upstream advisories exist without an SBOM.
- Source problems are evidence limitations, not repository edits: wrong RFC9121 actor citation; blocked ISO; withdrawn NIST800-53A and cited 800-161r1; trust-zone/boundary and organisational policy meanings not directly defined by cited standard pages.
- Dedicated PDF extraction used `uv run --with pypdf python ...` in an isolated ephemeral environment; no package was installed in the persistent orchestration kernel.

## URL-by-URL access and relevant findings

### https://community.owasp.org/Threat_Modeling
Access: HTTP 200; accessed 2026-11-12.
Substantive community guide read. A model contains subject description, assumptions, threats and mitigations. Four questions start with system scope, then threats, then countermeasures. Supports model -> system, threat -> model, mitigation -> threat; not requiring all contained child records before the model.

### https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines
Access: HTTP 200; accessed 2026-11-12.
Substantive project overview read, not every linked cryptographic publication. Lists primitives, algorithms, schemes, cipher techniques, signatures, key management and validation. Algorithm descriptions are independently reusable; it does not prescribe this catalog dependency graph.

### https://csrc.nist.gov/projects/ssdf
Access: HTTP 200; accessed 2026-11-12.
Substantive project text read. SSDF practices are outcome-based reusable practices with IDs, tasks and optional implementation examples; four practice groups. Specific processes implement practices, rather than defining the authoritative practice.

### https://csrc.nist.gov/pubs/sp/800/161/r1/final
Access: HTTP 200; accessed 2026-11-12.
Publication landing page and full abstract read, NOT the full linked publication. It concerns identifying, assessing and mitigating risks throughout acquisition supply chains. Warning: this exact cited edition was withdrawn 2024-11-01 and superseded by an updated Rev.1. Supplier relationships are the subject of agreements, assessments and chain risks; it does not mandate a completed assessment before a risk can be stated.

### https://csrc.nist.gov/pubs/sp/800/207/final
Access: HTTP 200; accessed 2026-11-12.
Publication landing page and abstract read, NOT the full linked publication. Zero trust separates authentication and authorization, focuses on users/assets/resources and rejects implicit network-location trust. Supports separating accounts, policies and grants; exact role/grant graph is an interpretation of YAML, not a normative mandate of the abstract.

### https://csrc.nist.gov/pubs/sp/800/216/final
Access: HTTP 200; accessed 2026-11-12.
Landing page and abstract read, NOT full publication. Reports of suspected vulnerabilities are accepted, assessed and managed; confirmation/remediation follows receipt. A report need not already be a confirmed OSV vulnerability.

### https://csrc.nist.gov/pubs/sp/800/53/a/final
Access: HTTP 200; accessed 2026-11-12.
Landing page and abstract read, NOT full publication. Assessment plans examine controls using a system security plan. WARNING: cited 2008 edition withdrawn 2011-06-29 and superseded. Audit criteria precede examination, and findings follow it. Does not independently establish exception governance.

### https://cwe.mitre.org/about/new_to_cwe.html
Access: HTTP 200; accessed 2026-11-12.
Substantive introduction read. CWE is a list of common software/hardware weakness TYPES; observed CVEs are examples, not prerequisites for defining a CWE type.

### https://cyclonedx.org/docs/1.6/json/
Access: HTTP 200; accessed 2026-11-12.
Substantive 1.6 schema reference sections read (not every repeated schema expansion). BOM has components and dependency graphs; components have types/name/version and local bom-ref; cryptographic-asset type includes algorithms, protocols, certificates, keys, tokens and secrets. Did not find trustBoundary/trust-zone definitions in the 1.6 reference. Trust zone/boundary proposals therefore use their YAML meanings plus OWASP system-scope guidance, NOT a claim that 1.6 normatively defines those concepts.

### https://docs.oasis-open.org/cti/stix/v2.1/stix-v2.1.html
Access: HTTP 200; accessed 2026-11-12.
Substantive specification sections 4.7, 4.16 and 4.17 read. Indicator requires a detection pattern and validity context; actor/campaign relationships optional. Threat actors have motives/capabilities/resources independent of a specific local modeled system. Reports aggregate intelligence objects. Large specification not read in full.

### https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
Access: HTTP 200; accessed 2026-11-12.
Substantive specification result/run/location/suppression sections read from shared cached body. SARIF captures analysis runs, rule-linked results, optional locations and explicit suppression decisions about results. It does not define catalog-specific SAST/DAST/secret-scan prerequisites or general secret references; those use the individual YAML target semantics. Large specification not read in full.

### https://docs.oasis-open.org/security/saml/v2.0/
Access: HTTP 200; accessed 2026-11-12.
Directory index read, not sufficient substantive SSO evidence by itself; followed profiles PDF below.

### https://gdpr-info.eu/art-30-gdpr/
Access: HTTP 200; accessed 2026-11-12.
Full article text read. Controller records require processing purposes, categories of data subjects and personal data; recipients and international transfers are recorded when applicable; safeguards accompany transfers. Avoided requiring transfer as universal processing prerequisite.

### https://gdpr-info.eu/art-5-gdpr/
Access: HTTP 200; accessed 2026-11-12.
Full article text read. Data must be collected for specified, explicit legitimate purposes and limited to necessity; purpose can precede its concrete processing activity.

### https://gdpr-info.eu/art-7-gdpr/
Access: HTTP 200; accessed 2026-11-12.
Full article text read. Controller demonstrates consent to processing; withdrawal must be possible and as easy as giving consent. Consent therefore identifies the processing agreed to.

### https://github.com/OWASP/ASVS/tree/master/5.0/en
Access: HTTP 200; accessed 2026-11-12.
Substantive directory listing only: visible chapter names and files, not enough to claim requirement contents read. Followed raw explanatory chapter below.

### https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md
Access: HTTP 200; accessed 2026-11-12.
Substantive rendered spec read, including statement and fields. A statement intersects product(s), vulnerability and impact status; not_affected requires justification or impact statement. A complete SBOM is not mandatory before a VEX statement.

### https://github.com/ossf/scorecard/blob/main/docs/checks.md
Access: HTTP 200; accessed 2026-11-12.
Substantive rendered check descriptions read, including SAST, SBOM and permission checks with risks/remediations. Checks inspect repository evidence; low scores are not proof a vulnerability exists.

### https://kubernetes.io/docs/reference/kubernetes-api/
Access: HTTP 200; accessed 2026-11-12.
API reference index/introduction read. Index links Secret and ServiceAccount but does not explain their semantics; followed dedicated concept pages below.

### https://ossf.github.io/osv-schema/
Access: HTTP 200; accessed 2026-11-12.
Substantive schema overview and affected/package/ranges sections read. Vulnerabilities identify affected packages and affected/fixed version ranges; a prior BOM or CWE mapping is not required. Large schema not read in full.

### https://owasp.org/www-project-web-security-testing-guide/
Access: HTTP 200; accessed 2026-11-12.
Redirected to project overview; substantive overview read, not every linked testing chapter. It identifies WSTG as web application/service security testing guidance. Scope/authorization interpretation comes from penetration-test YAML.

### https://pages.nist.gov/OSCAL/learn/concepts/layer/
Access: HTTP 200; accessed 2026-11-12.
Full substantive page read. Catalog is basis; controls originate there; profiles select/tailor controls. Component definitions and SSP describe implementation against a baseline. Assessment is in context of a system implementation and defined controls; plans precede results and POAM addresses findings. Policy is not actually a separate OSCAL model listed here; organisational rule meaning comes from YAML.

### https://spdx.github.io/spdx-spec/v3.0.1/
Access: HTTP 200; accessed 2026-11-12.
Substantive specification overview read, not entire linked standard. Followed licensing profile and vulnerability class below.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Licensing/
Access: HTTP 200; accessed 2026-11-12.
Only HTML redirect text returned, NOT substantive profile. Followed target Licensing/Licensing/ below.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Security/Classes/Vulnerability/
Access: HTTP 200; accessed 2026-11-12.
Full class page read. Vulnerability has description/identifiers and example relationships to affected software. The class does not require a prior CWE classification.

### https://w3c.github.io/dpv/2.0/dpv/
Access: HTTP 200; accessed 2026-11-12.
Only moved-page notice returned, NOT substantive vocabulary; followed w3c-cg.github.io target below.

### https://www.hackerone.com/
Access: HTTP 200; accessed 2026-11-12.
Substantive marketing homepage read, not a standard. Describes researchers, scoped bounty challenges and rewards. Program rules and reporting scope derive from YAML and disclosure-policy interpretation.

### https://www.iso.org/standard/72891.html
Access: HTTP 403; accessed 2026-11-12.
BLOCKED HTTP403 Cloudflare JavaScript/cookies challenge. No standard or paywalled ISO content read. Used accessible Common Criteria 2022 Part 1 below; does not establish exact equivalence to every ISO edition clause.

### https://www.rfc-editor.org/rfc/rfc5280.html
Access: HTTP 200; accessed 2026-11-12.
Relevant substantive certificate structure and public-key sections read. SubjectPublicKeyInfo names algorithm and key, certificate validity is bounded. It is a PKIX certificate profile, not a general secret-key lifecycle standard; general key storage/expiry meaning comes from YAML.

### https://www.rfc-editor.org/rfc/rfc7644.html
Access: HTTP 200; accessed 2026-11-12.
Substantive protocol abstract and identity resource/provisioning sections read. HTTP provisioning manages user resources across domains. A directory needs service context; no prior populated account inventory is necessary to describe a provisioning directory.

### https://www.rfc-editor.org/rfc/rfc9116.html
Access: HTTP 200; accessed 2026-11-12.
Substantive security.txt policy/contact/scope sections read. Policy field points to reporting practices and Contact to disclosure destination. It is not a general security-advisory schema: advisory prerequisites use YAML affected-version/fix meaning.

### https://www.rfc-editor.org/rfc/rfc9121.html
Access: HTTP 200; accessed 2026-11-12.
Full short RFC text read. WRONG CITATION: Deprecating Infrastructure int Domains, unrelated to threat actors. Not used as evidence for attacker semantics. Supplemented with STIX section 4.17, not silently repaired repository source.

### https://w3c-cg.github.io/dpv/2.0/dpv/
Access: HTTP 200; accessed 2026-11-12.
Substantive DPV introduction/core concept/taxonomy sections read. Purpose, PersonalData and LegalBasis are independent core concepts; rich classifications of data subjects and personal data can precede a concrete processing record. Not all 720k text read.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Licensing/Licensing/
Access: HTTP 200; accessed 2026-11-12.
Full licensing profile page read. Distinguishes declared vs concluded licenses; artifacts relate to license definitions. Profile does not define commercial supplier agreements, so those use YAML supplier/permission semantics.

### https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x03-What-is-the-ASVS.md
Access: HTTP 200; accessed 2026-11-12.
Substantive ASVS explanatory chapter read. Standard defines web application/service security requirements and priority-based L1/L2/L3. Authoritative requirements can be recorded before a particular product implements them; not a claim all ASVS chapter requirements read.

### https://kubernetes.io/docs/concepts/security/service-accounts/
Access: HTTP 200; accessed 2026-11-12.
Substantive concept page read. Service accounts are non-human Kubernetes identities and each is bound to a namespace; namespace creates a default account. Pods and RBAC consumers need not pre-exist.

### https://kubernetes.io/docs/concepts/configuration/secret/
Access: HTTP 200; accessed 2026-11-12.
Substantive secret overview and usage/type sections read. Secret stores password/token/key and can be created independently of using pods; avoids requiring consumers before the secret.

### https://www.commoncriteriaportal.org/files/ccfiles/CC2022PART1R1.pdf
Access: HTTP 200; accessed 2026-11-12.
Accessible official Common Criteria PDF fetched and extracted with isolated uv-run pypdf after pdftotext was unavailable. Relevant definitions (3.68 protection profile, security target) and sections 7,10,12 inspected, not full 167-page publication. Protection profile is implementation-independent security needs for TOE TYPE; target is implementation-dependent needs for a specific TOE. Confirms profile root and product-specific target, optional profile conformance.

### https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf
Access: HTTP 200; accessed 2026-11-12.
Official profiles PDF fetched/extracted through same isolated tool. Web Browser SSO section 4.1 inspected, not full 64-page specification: relying service selects identity provider, issues request, processes response and grants/denies access. Federation trust configuration can precede actual provisioned users.

---

## Review batch 4

# Prerequisite dependency proposal: operations, resilience, decommissioning, infrastructure

96 kinds; all 96 YAML files read from repository and definitions/descriptions compared with catalog. 41 distinct cited URLs fetched. Access date 2026-11-12 UTC. No repository changes. Canonical IDs retained for parent normalization to file-basename names.

## Interpretation and limitations

- Lists are conceptual prerequisites to fill the kind, not foreign-key requirements or a list of associations. Existing resources can be described without completed lifecycle plans. Parent records do not require child inventory first.
- c4.container is the catalog deployable-service context, not necessarily an OS container; Kubernetes image refers instead to practice.container-image.
- Kubernetes autoscaler supports multiple scale-target controller kinds: use namespace + application context rather than falsely requiring both Deployment and StatefulSet. Runtime replicas can be absent while desired specs exist.
- Recovery points can come from backup or replication, and backups may hold system configuration rather than domain entities: use identified software system without requiring one alternative mechanism.
- Prometheus metric expressions may use externally supplied metrics without a locally declared instrument. otel.metric-instrument is the closest catalog metric identity but may overconstrain imported metrics; owner should confirm whether this kind intentionally covers them.
- SLA <- SLO is conceptual: a separately cataloged SLO need not exist operationally when an agreement contains the target inline. Same interpretation applies to other represented prerequisite concepts.
- Package <- manifest is deliberately NOT used here: package identity precedes manifest, and manifest precedes declared dependencies/lockfile. Parent must check cross-group cycles.
- Broad citations are not treated as proof of all local kinds. Weak links are called out below (notably RFC8594/maintenance, Kubernetes Job/database-change, SPDX/package-manager files, OTEL/arbitrary environment settings). No paywalled source was used or claimed read.

## Cited source access and meaning

### https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final
- Access: HTTP 200; 2026-11-12T14:48:16.266589+00:00; final URL: https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final. Cached: `/tmp/derives-standard-cache/f561a6295e1b6a094877510a19146d3c38995c77216428e1f8bc29019a8014b2.html`.
- Relevant review: Read landing abstract and full linked Rev.1 PDF (all pages extracted, targeted review of §2 plan relationships, §3 BIA/recovery strategies/testing, §4 activation/recovery and appendices). Seven-step process puts BIA before strategies/plans and testing after plans. RTO bounds outage and RPO bounds tolerable data loss. Backup, off-site replication and alternate sites are different strategies, not all mandatory. BCP maintains business processes; DRP handles major/site disruption; guide explicitly does not fully specify facility-level DRP or business continuity. Catalog DRP-as-part-of-contingency is a local specialization, not claimed as a NIST hierarchy mandate.

### https://csrc.nist.gov/pubs/sp/800/88/r1/final
- Access: HTTP 200; 2026-11-12T14:48:16.188425+00:00; final URL: https://csrc.nist.gov/pubs/sp/800/88/r1/final. Cached: `/tmp/derives-standard-cache/42cbb086f712a8ecdcbfa38f408db849a2fee0b6a08eaaff654bd56a1909d34d.html`.
- Relevant review: Read landing and full linked Rev.1 PDF (all pages extracted; reviewed confidentiality classification, sanitization decisions, destruction and Appendix G certificate). Select sanitization from information sensitivity and media; document and verify outcomes. Rev.1 is withdrawn (2025-09-26), superseded by Rev.2. Catalog still cites Rev.1; no source change proposed.

### https://cyclonedx.org/docs/1.6/json/
- Access: HTTP 200; 2026-11-12T14:48:17.813554+00:00; final URL: https://cyclonedx.org/docs/1.6/json/. Cached: `/tmp/derives-standard-cache/bd2ad2353bafa158cfcffd79e2a2cbe2a8d58988d720ca17e7a65c28012a12c5.html`.
- Relevant review: Read service trust-boundary and trustZone fields in JSON reference. Services can declare whether access crosses a trust boundary and the zone name. This supports named trust-zone context, not a general firewall/security-group dependency schema.

### https://developer.hashicorp.com/terraform/language/modules
- Access: HTTP 200; 2026-11-12T14:48:16.069213+00:00; final URL: https://developer.hashicorp.com/terraform/language/modules. Cached: `/tmp/derives-standard-cache/5c02a993e8234ec3bc93071d0825d4b34aef22134dfd903244e3149f8bac4834.html`.
- Relevant review: A module is a collection of resources; root configuration calls child modules. Source location identifies a module independently of its resource contents.

### https://developer.hashicorp.com/terraform/language/providers
- Access: HTTP 200; 2026-11-12T14:48:16.065556+00:00; final URL: https://developer.hashicorp.com/terraform/language/providers. Cached: `/tmp/derives-standard-cache/9aa82c952203b094b7f9dfbfd6a92fe3706dcc8c42fed32ae78ee9e24b1091e1.html`.
- Relevant review: Providers are plugins implementing resource types and APIs; resources need provider type semantics. Provider configuration/requirements live in Terraform configurations.

### https://developer.hashicorp.com/terraform/language/resources
- Access: HTTP 200; 2026-11-12T14:48:16.029308+00:00; final URL: https://developer.hashicorp.com/terraform/language/resources. Cached: `/tmp/derives-standard-cache/0001d2c1b6095d789de3df6d9280cab828877414082965645bbac71f9ae7acb5.html`.
- Relevant review: Resource blocks specify infrastructure objects and provider-specific arguments; initialize downloads required providers/modules, apply creates and changes objects.

### https://developer.hashicorp.com/terraform/language/state
- Access: HTTP 200; 2026-11-12T14:48:16.143626+00:00; final URL: https://developer.hashicorp.com/terraform/language/state. Cached: `/tmp/derives-standard-cache/6195cfbf73021c3664b55484e412fb7cc58bd2612528f205f676117a1ac6cf17.html`.
- Relevant review: State binds remote objects to configured resource instances and tracks metadata. It is workspace/configuration scoped; empty state is possible.

### https://developer.hashicorp.com/terraform/language/values/variables
- Access: HTTP 200; 2026-11-12T14:48:16.075456+00:00; final URL: https://developer.hashicorp.com/terraform/language/values/variables. Cached: `/tmp/derives-standard-cache/24e9faeea9ac7f3b8c8b7a77362839e91e7b440f766aeb597e3913daf9be3f59.html`.
- Relevant review: Variable blocks define module input interfaces. Values may be passed by root-module users or parent modules; particular resources are consumers.

### https://docs.docker.com/compose/
- Access: HTTP 200; 2026-11-12T14:48:15.991630+00:00; final URL: https://docs.docker.com/compose/. Cached: `/tmp/derives-standard-cache/cd0401a9890bdf9f2336b1e6d418677f9bc431eb5c38ad24fe3065b17c9a3e03.html`.
- Relevant review: Overview says Compose defines multi-container applications as services, networks and volumes. Too broad for healthcheck fields; supplementary service reference reviewed.

### https://dora.dev/guides/dora-metrics/
- Access: HTTP 200; 2026-11-12T14:48:15.964302+00:00; final URL: https://dora.dev/guides/dora-metrics/. Cached: `/tmp/derives-standard-cache/0c65873b24c32d5f18d30225e62a1e66c732665e658f37d421f485fb1884971a.html`.
- Relevant review: Read throughput/instability metrics: change lead time, deployment frequency and failure/recovery measures. Supports recording applied changes and outcomes, not a normative change-record schema.

### https://endoflife.date/
- Access: HTTP 200; 2026-11-12T14:48:16.091631+00:00; final URL: https://endoflife.date/. Cached: `/tmp/derives-standard-cache/c105416c5410866b850ca96f123e3eda5b69792d0d5b6c120227ae9096a704d4.html`.
- Relevant review: Homepage describes product version support/EOL lifecycle aggregation. Supports identifying upgraded technology/version; does not prescribe upgrade procedures.

### https://grafana.com/docs/grafana/latest/dashboards/
- Access: HTTP 200; 2026-11-12T14:48:16.079058+00:00; final URL: https://grafana.com/docs/grafana/latest/visualizations/dashboards/. Cached: `/tmp/derives-standard-cache/81dbb8bea938bf7f9fc5a0e4c85e344a99674988d1af0816fe4f5a88e864ea8b.html`.
- Relevant review: Dashboard is one or more panels; panels query/transform data sources into visualizations. Dashboard need not require pre-existing separate panel records; panel belongs to dashboard.

### https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
- Access: HTTP 200; 2026-11-12T14:48:16.606513+00:00; final URL: https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/. Cached: `/tmp/derives-standard-cache/790a0b0111db088f8ea3d4ad53770743fa44e5aa94a3ac5739e11c0a0be6432a.html`.
- Relevant review: CronJob starts Jobs on repeating schedules; schedule and job template define the controller before executions. Jobs/pods may be absent, skipped or duplicated.

### https://kubernetes.io/docs/concepts/workloads/controllers/job/
- Access: HTTP 200; 2026-11-12T14:48:16.685523+00:00; final URL: https://kubernetes.io/docs/concepts/workloads/controllers/job/. Cached: `/tmp/derives-standard-cache/bc994bade3e5e8be49fee4bde47700f10ed07d7f059cda258d1aad0bda25d951.html`.
- Relevant review: Jobs represent one-off tasks, create Pods and retry to completion. Useful only as an example execution mechanism; it does not define database migrations or rollback.

### https://kubernetes.io/docs/reference/kubernetes-api/
- Access: HTTP 200; 2026-11-12T14:48:16.902973+00:00; final URL: https://kubernetes.io/docs/reference/kubernetes-api/. Cached: `/tmp/derives-standard-cache/38b9f42a80e38aca0289332e44aed3c683750adf5a9cfad942faa0906f724be3.html`.
- Relevant review: API overview explains declarative records of intent and API groups; not enough detail for individual object prerequisites. Supplementary official concepts pages reviewed.

### https://opentelemetry.io/docs/concepts/signals/
- Access: HTTP 200; 2026-11-12T14:48:16.830522+00:00; final URL: https://opentelemetry.io/docs/concepts/signals/. Cached: `/tmp/derives-standard-cache/d2e6da6b56bae3df70ff26fd15ef91c9e7e3d7164b19bf2d5b9824da38858a31.html`.
- Relevant review: Signals are collected, processed and exported system outputs; pipeline direction is emitter to backend, not dependent on downstream dashboards.

### https://opentelemetry.io/docs/concepts/signals/logs/
- Access: HTTP 200; 2026-11-12T14:48:16.754985+00:00; final URL: https://opentelemetry.io/docs/concepts/signals/logs/. Cached: `/tmp/derives-standard-cache/74cb6882ca061d08e21ab1a458321fd28302a9104b4750c51d1a28db0a201e15.html`.
- Relevant review: Logs are timestamped records with optional metadata, produced directly or through existing frameworks and bridges; logger initialization record is not universally required.

### https://opentelemetry.io/docs/concepts/signals/metrics/
- Access: HTTP 200; 2026-11-12T14:48:16.668715+00:00; final URL: https://opentelemetry.io/docs/concepts/signals/metrics/. Cached: `/tmp/derives-standard-cache/e1c6486dac03bd7b4f66382b6da217bbd8cafc7f69d6553f2fa8d7f1271851a1.html`.
- Relevant review: Metrics measure services at runtime; meters create instruments including counters/gauges/histograms, exporters send data onward. Instrument declarations are not alert consumers.

### https://opentelemetry.io/docs/concepts/signals/traces/
- Access: HTTP 200; 2026-11-12T14:48:16.699022+00:00; final URL: https://opentelemetry.io/docs/concepts/signals/traces/. Cached: `/tmp/derives-standard-cache/f94e6a8959c528040f1f9b2c2423b2a3bd80625f08fdef3a0d22eb6ff99904f6.html`.
- Relevant review: Traces comprise timed operation spans; root spans have null parent. Do not add a self-kind parent-span prerequisite.

### https://opentelemetry.io/docs/specs/semconv/resource/
- Access: HTTP 200; 2026-11-12T14:48:16.952315+00:00; final URL: https://opentelemetry.io/docs/specs/semconv/resource/. Cached: `/tmp/derives-standard-cache/1abac800ca69716fca762cc80c4a06cab748f51db85e7cfec6f58dbe13c0899f.html`.
- Relevant review: Resource attributes identify service, compute instance, environment and cloud context. Dedicated service.name environment setting is mentioned, but this is not a specification for arbitrary environment-variable declarations/definitions.

### https://opentelemetry.io/docs/specs/semconv/resource/host/
- Access: HTTP 200; 2026-11-12T14:48:16.815756+00:00; final URL: https://opentelemetry.io/docs/specs/semconv/resource/host/. Cached: `/tmp/derives-standard-cache/633eb2c65d60e1b4daf602a48ad12673098eb2564b9693ad7a32e82c1fed56d5.html`.
- Relevant review: Host denotes a physical or virtual computing instance; attributes include identity, architecture, IP and machine type. Kubernetes/cloud deployment is optional.

### https://opentelemetry.io/docs/specs/semconv/resource/process/
- Access: HTTP 200; 2026-11-12T14:48:17.141969+00:00; final URL: https://opentelemetry.io/docs/specs/semconv/resource/process/. Cached: `/tmp/derives-standard-cache/8e9cb0c5539430c5aa0b0d268609f6dbdda937d8260b967fc5e51587cc86ece1.html`.
- Relevant review: Process identity uses creation time/PID; command and runtime attributes describe OS execution. Host networking ports are not its standard-mandated prerequisite.

### https://owasp.org/www-project-modsecurity-core-rule-set/
- Access: HTTP 200; 2026-11-12T14:48:17.395627+00:00; final URL: https://owasp.org/projects/crs. Cached: `/tmp/derives-standard-cache/249c05be6cb4626ae9dd58f52de82972c2ad14d7e1bfe03b5fce9f6bac3bccaa.html`.
- Relevant review: CRS is generic attack-detection rules for ModSecurity-compatible WAF engines protecting web applications. Protected interface is meaningful before any particular traffic is observed.

### https://prometheus.io/docs/alerting/latest/configuration/
- Access: HTTP 200; 2026-11-12T14:48:17.401616+00:00; final URL: https://prometheus.io/docs/alerting/latest/configuration/. Cached: `/tmp/derives-standard-cache/4f002c665f01150ee3f040aceb740da9778f67af8798565cbc00c5b52342de8d.html`.
- Relevant review: Read routing tree, group_by, receiver and timing configuration. Routes select receiver by labels; grouping labels/timing are route parameters. Receiver can exist without route/alert-rule entries.

### https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
- Access: HTTP 200; 2026-11-12T14:48:17.134939+00:00; final URL: https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/. Cached: `/tmp/derives-standard-cache/f751f6208cdee669243fc61ed4087e45ca9ef7b29cbac3666373564faeca07d2.html`.
- Relevant review: PromQL expressions produce label sets of active alerts; optional for duration delays firing. A particular metric is prerequisite, notification routing is downstream.

### https://spdx.github.io/spdx-spec/v3.0.1/model/
- Access: HTTP 200; 2026-11-12T14:48:17.056449+00:00; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/. Cached: `/tmp/derives-standard-cache/6c4ed4b6c2c7e3e3d0ee403aa6185380c4f7bf967bb952c89b81d55128b0feda.html`.
- Relevant review: HTTP 200 is a meta-refresh redirect only, not specification content. Followed it to /model/Core/Core/ and read Core description. SPDX is a general element/relationship model, weak evidence for actual manifest/lockfile behavior.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/
- Access: HTTP 200; 2026-11-12T14:48:17.328591+00:00; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/. Cached: `/tmp/derives-standard-cache/a3c055b3a694d082fa0c242678664920130faa9c550532db293c792ce42f60fd.html`.
- Relevant review: Read relationship direction guidance and dependsOn/runtime/build dependency vocabularies. Relationships distinguish dependency direction. Does not define package.json/go.mod or lockfile schemas.

### https://sre.google/sre-book/service-level-objectives/
- Access: HTTP 200; 2026-11-12T14:48:17.014842+00:00; final URL: https://sre.google/sre-book/service-level-objectives/. Cached: `/tmp/derives-standard-cache/7b9a3e66dbb9cd315c623eae566091359ae03e23c756791cbce402c9eb7191f2.html`.
- Relevant review: Read Indicators/Objectives/Agreements. SLI is quantitative service measure; SLO is target/range over SLI; SLA adds agreement and consequences for missing objectives.

### https://sre.google/workbook/implementing-slos/
- Access: HTTP 200; 2026-11-12T14:48:17.298543+00:00; final URL: https://sre.google/workbook/implementing-slos/. Cached: `/tmp/derives-standard-cache/06c934af218eb6a543dee972ab5519b933d8518e382abc1e2dc2d4a5d4ba8c36.html`.
- Relevant review: Read SLO/error-budget policy sections. Budget is allowed unreliability from objective; policy dictates operational response when budget spent.

### https://sre.google/workbook/incident-response/
- Access: HTTP 200; 2026-11-12T14:48:17.210309+00:00; final URL: https://sre.google/workbook/incident-response/. Cached: `/tmp/derives-standard-cache/c9b984c49b8f6c742647ae09b0b08483187e10583f1859eccb642ff5b11d03ef.html`.
- Relevant review: Structured response coordinates responders, roles, communication and mitigation during incident. Response actions are live records, not dependent on finished retrospective.

### https://sre.google/workbook/on-call/
- Access: HTTP 200; 2026-11-12T14:48:17.315327+00:00; final URL: https://sre.google/workbook/on-call/. Cached: `/tmp/derives-standard-cache/9883bafebb411c68aa4e4cf5978027386f20d955c76dcfe52eee3a05f23bac6a.html`.
- Relevant review: Read team ramp-up, rota coverage, primary/backup escalation examples and operational readiness. Rota establishes responders before escalation actions; not a mandatory vendor-specific policy schema.

### https://sre.google/workbook/postmortem-culture/
- Access: HTTP 200; 2026-11-12T14:48:17.452031+00:00; final URL: https://sre.google/workbook/postmortem-culture/. Cached: `/tmp/derives-standard-cache/8e60629cd90d098c10e4046b619db7fb8e42faaabef77b03e1d925cd36a7ac8e.html`.
- Relevant review: Read incident/postmortem examples, impact, root causes, timeline and tracked actions. Postmortem follows incident; action items follow findings. Incident can be recorded before timeline details completed.

### https://www.rfc-editor.org/rfc/rfc1035.html
- Access: HTTP 200; 2026-11-12T14:48:17.534095+00:00; final URL: https://www.rfc-editor.org/rfc/rfc1035.html. Cached: `/tmp/derives-standard-cache/8339836d4391523dd8ee428a94b37bae71f6ab2f64b3724fc65da3f8323456de.html`.
- Relevant review: Read §3.2 resource record format: NAME is owner name; TYPE, CLASS, TTL and type-specific RDATA describe record. Name is logically prior to its DNS record.

### https://www.rfc-editor.org/rfc/rfc4632.html
- Access: HTTP 200; 2026-11-12T14:48:17.558602+00:00; final URL: https://www.rfc-editor.org/rfc/rfc4632.html. Cached: `/tmp/derives-standard-cache/c6210b0cf68d98d2ad25b256174533206b84ab41018e5567b1f0d6a2247c69aa.html`.
- Relevant review: Read CIDR prefix notation/address allocation explanation. An address range is an allocation that rules/networks use, not dependent on consumer firewall records.

### https://www.rfc-editor.org/rfc/rfc4949.html
- Access: HTTP 200; 2026-11-12T14:48:17.845375+00:00; final URL: https://www.rfc-editor.org/rfc/rfc4949.html. Cached: `/tmp/derives-standard-cache/ae5d68e7bd8a6a0f5506040f0451dcd5a4105e9f440f29db7a398de32a06c7f2.html`.
- Relevant review: Read firewall entry: controlled gateway between networks of differing security postures applies traffic policy. No cloud security-group schema; that usage is local practice.

### https://www.rfc-editor.org/rfc/rfc5280.html
- Access: HTTP 200; 2026-11-12T14:48:17.822249+00:00; final URL: https://www.rfc-editor.org/rfc/rfc5280.html. Cached: `/tmp/derives-standard-cache/7e022b9f7d9ff2bca6475ea54fef494093ac27bba4926a0e2aca06e598d4a555.html`.
- Relevant review: Read certificate/subject/public-key and subject-alternative-name sections. Certificate binds public key and identity; subjects need not be DNS names. Key material prerequisite does not mean private key disclosure.

### https://www.rfc-editor.org/rfc/rfc6335.html
- Access: HTTP 200; 2026-11-12T14:48:17.780398+00:00; final URL: https://www.rfc-editor.org/rfc/rfc6335.html. Cached: `/tmp/derives-standard-cache/e1a2f578fc381044e1461a2ea9bd214fb7278daeb4217a84ac1d247a8db57bed.html`.
- Relevant review: Read service-name/transport port registry rationale. Ports are interpreted with transport protocols and identify services, not independent application identities.

### https://www.rfc-editor.org/rfc/rfc7230.html
- Access: HTTP 200; 2026-11-12T14:48:17.802497+00:00; final URL: https://www.rfc-editor.org/rfc/rfc7230.html. Cached: `/tmp/derives-standard-cache/4267c4857edf955a6e154c942ddc9c15999027070a4330af4401344b13d51c56.html`.
- Relevant review: Read intermediary/gateway definitions and load-balancing example. HTTP gateways may partition traffic across machines; not a complete generic load-balancer or health-check specification. Historical RFC largely superseded by 9110/9112.

### https://www.rfc-editor.org/rfc/rfc791.html
- Access: HTTP 200; 2026-11-12T14:48:17.960030+00:00; final URL: https://www.rfc-editor.org/rfc/rfc791.html. Cached: `/tmp/derives-standard-cache/b9e32ff2c26eb44af95e0799e4f2dd4c678422ac5bb04f31be89ca50de58cc2d.html`.
- Relevant review: Read scope and relation to other protocols: IP supplies datagram delivery; protocol definition stands independently of consuming product endpoints. This is one protocol example, not a universal protocol taxonomy.

### https://www.rfc-editor.org/rfc/rfc8594.html
- Access: HTTP 200; 2026-11-12T14:48:17.961436+00:00; final URL: https://www.rfc-editor.org/rfc/rfc8594.html. Cached: `/tmp/derives-standard-cache/7c5463b207654714dcbe3c3a163bcef22cd5c7c6ee0601d65ac0ad68cd7c5ead.html`.
- Relevant review: Read Sunset header abstract/scope: URI expected to become unresponsive at future instant, link to sunset information. Supports withdrawal notice; not an SLA maintenance-window specification and not proof of migration steps.

### https://www.rfc-editor.org/rfc/rfc9110.html
- Access: HTTP 200; 2026-11-12T14:48:18.100874+00:00; final URL: https://www.rfc-editor.org/rfc/rfc9110.html. Cached: `/tmp/derives-standard-cache/b1b13a12aee75c6ecc20fb910c724cdfd1e4d841add5e14d1dd4a2006727a9ad.html`.
- Relevant review: Read §3.7 intermediary definitions: proxy forwards/translates requests, gateway/reverse proxy acts as origin toward clients and forwards inbound. Covers caching/transformation and HTTP protocol context.

## Supplementary official pages

- https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Core/: HTTP 200, 2026-11-12T14:49:06.350573+00:00. Read substantive Core model description after following the meta redirect; distinguishes generic SPDX model from actual package-manager conventions. Cached `/tmp/derives-standard-cache/03f9ec73d6843582167d4352f850598bdb11bbbb3301bb4d6ffd2ad15a668981.html`.
- https://docs.docker.com/reference/compose-file/services/#healthcheck: HTTP 200, 2026-11-12T14:49:06.376261+00:00. Read service `healthcheck` reference: command/test, interval, timeout, retries, start period and start interval describe service health check; no HTTP endpoint necessarily exists. Cached `/tmp/derives-standard-cache/4f304a84b15eb8348862b91cfd612b31adc20e8d77ccd2db7338d4545a0f9ac1.html`.
- https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/: HTTP 200, 2026-11-12T14:49:06.487000+00:00. Namespaces scope names inside one cluster, with Deployments/Services namespaced and Nodes cluster scoped. Cached `/tmp/derives-standard-cache/0663647ebd0b03ca9b6a685fde4369a4c1bd07eadc6fef30079bfb37047e3f5c.html`.
- https://kubernetes.io/docs/concepts/workloads/: HTTP 200, 2026-11-12T14:49:06.468853+00:00. Workloads use Pods; controllers create Pods from intent. Specs can be filled before generated instances. Cached `/tmp/derives-standard-cache/3e9846ed97bc01f67c70e4a5d40403bf16a6092b6f2d8dda82f3ae7995b198de.html`.
- https://kubernetes.io/docs/concepts/services-networking/service/: HTTP 200, 2026-11-12T14:49:06.313250+00:00. Service exposes application endpoint; Pods are ephemeral and selectors can be absent. A concrete Deployment is not universally required. Cached `/tmp/derives-standard-cache/fb91f3263e9011cc78775187f77d5f86d51ca722843427d14243c9e4af32994b.html`.
- https://kubernetes.io/docs/concepts/configuration/: HTTP 200, 2026-11-12T14:49:06.503968+00:00. ConfigMap and Secret store configuration independently from consuming pods, allowing configuration to be supplied later. Cached `/tmp/derives-standard-cache/ebea63a8dccd1585a0fb26c21aafd4b269344a8a68efe7ab8c04bc16428ce288.html`.
- https://kubernetes.io/docs/concepts/architecture/nodes/: HTTP 200, 2026-11-12T14:49:06.337003+00:00. Node is physical or virtual machine managed by cluster control plane; grouping nodes does not make them prerequisite to defining cluster. Cached `/tmp/derives-standard-cache/5445bee6c17b8734d3cd0e4132430c8e7a204466ecd444c9fe6304177183bd33.html`.
- https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/: HTTP 200, 2026-11-12T14:49:06.365877+00:00. Probes configure container liveness/readiness/startup; examples include command checks and HTTP, so endpoint records are not universal. Cached `/tmp/derives-standard-cache/e1c0be00b2d1f0395aed0e8ba295c120294078dbf493dfefe600d456ca2baa2e.html`.
- https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-34r1.pdf: HTTP 200; retrieved 2026-11-12 UTC; full PDF extracted with pypdf in scratch uv environment to `/tmp/derives-standard-cache/nist-0.txt`; used for NIST findings above.
- https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-88r1.pdf: HTTP 200; retrieved 2026-11-12 UTC; full PDF extracted with pypdf in scratch uv environment to `/tmp/derives-standard-cache/nist-1.txt`; used for NIST findings above.

## Sole root

- `practice.protocol`: independently specified rules can be described from a protocol standard before any product, port or endpoint consumes them. Product-specific usage does not define the protocol.

## Validation

- Exact assigned coverage: 96/96, no duplicates.
- All prerequisite values are exact canonical IDs in the supplied 521-entry catalog (519 kinds plus two excluded presets). No preset reference.
- No self edges or cycles in the assigned subgraph. Cross-group cycles require combined review.
- No repository files edited; outputs are scratch proposal artifacts only.

---

## Review batch 5

# Delivery and testing prerequisite proposal — source record

Task: madarch-64o5.28. Proposal only; no repository files edited. Accessed 2026-11-12 using requests HTTP GET and cached responses in /tmp/derives-standard-cache. Read all 68 owned YAML definitions/descriptions and all catalog entries. Each edge is a proposed nearest fill prerequisite, not a standard-mandated kind graph. Standards ground the meaning; local definitions decide catalog scope.

## Limitations and interpretation

- GNU cited manual and alternate HTML node returned 403; accessible public GNU source mirror section used instead. No paywalled source was claimed read.
- ISTQB HTML term routes returned only application shells; all 23 term meanings were successfully obtained from the application’s public API. API responses were read for definition/version fields, not all translation/syllabus metadata.
- SLSA builder identity overlaps platform identity; the local “identity used to run one build” is not a separate SLSA v1 schema concept and need not be an IAM account.
- OCI image-spec README does not specify Dockerfile syntax; supplemental Dockerfile guide was read. Image may be external, hence image is independently fillable.
- OpenFeature flag-set local definition adds provider/context scope absent from the glossary; proposal follows the local definition.
- DORA metrics do not formally define release gates or generic release kind semantics. Gate criteria and release prerequisites are reasoned from local definitions, not attributed to DORA.
- Helm charts source warns about Helm 4 currency; catalog lacks a chart kind, so spdx.file is the closest chart-definition carrier. Namespace supplies cluster context.
- Unqualified legacy code.file/code.test-case/code.commit/task references in quarantine YAML are not valid dependency IDs; proposal uses spdx.file indirectly via test case, istqb.test-case, practice.commit and practice.product-task.
- istqb.test-basis and istqb.defect use product as the common scope because code, documents, stories and requirements are alternative possible work products, not simultaneous mandatory inputs.
- Test suite depends on test cases (and environment); cases do not depend on suite. Reports/results/logs depend on executions, never the reverse. No goal/requirement feedback edges introduced.

## URL access and relevant meaning

### https://api.glossary.istqb.org/v1/terms/capacity-testing
- Access: 2026-11-12T14:49:07.609971+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/capacity-testing
- Findings: Public glossary API returned English definition (v1): Testing to evaluate the capacity of a system.

### https://api.glossary.istqb.org/v1/terms/coverage
- Access: 2026-11-12T14:49:07.774012+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/coverage
- Findings: Public glossary API returned English definition (v3): The degree to which specified coverage items are exercised by a test suite, expressed as a percentage.

### https://api.glossary.istqb.org/v1/terms/defect
- Access: 2026-11-12T14:49:07.260684+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/defect
- Findings: Public glossary API returned English definition (v3): An imperfection or deficiency in a work product where it does not meet its requirements or specifications or impairs its intended use.

### https://api.glossary.istqb.org/v1/terms/exploratory-testing
- Access: 2026-11-12T14:49:07.214944+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/exploratory-testing
- Findings: Public glossary API returned English definition (v4): A test approach in which tests are dynamically designed and executed based on tester's knowledge, exploration of a test item, and previous test results.

### https://api.glossary.istqb.org/v1/terms/failure
- Access: 2026-11-12T14:49:07.506027+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/failure
- Findings: Public glossary API returned English definition (v3): An event in which a component or system does not meet its requirements within specified limits during its execution.

### https://api.glossary.istqb.org/v1/terms/load-testing
- Access: 2026-11-12T14:49:07.177601+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/load-testing
- Findings: Public glossary API returned English definition (v2): A type of performance testing to evaluate the behavior of a component or system under varying loads, usually between anticipated conditions of low, typical, and peak usage.

### https://api.glossary.istqb.org/v1/terms/performance-testing
- Access: 2026-11-12T14:49:07.420642+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/performance-testing
- Findings: Public glossary API returned English definition (v2): A test type to determine the performance efficiency of a component or system.

### https://api.glossary.istqb.org/v1/terms/test-basis
- Access: 2026-11-12T14:49:07.790453+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-basis
- Findings: Public glossary API returned English definition (v2): The body of knowledge used as the basis for test analysis and test design.

### https://api.glossary.istqb.org/v1/terms/test-case
- Access: 2026-11-12T14:49:07.896786+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-case
- Findings: Public glossary API returned English definition (v2): A set of preconditions, inputs, actions (where applicable), expected results and postconditions, developed based on test conditions.

### https://api.glossary.istqb.org/v1/terms/test-charter
- Access: 2026-11-12T14:49:07.497541+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-charter
- Findings: Public glossary API returned English definition (v3): A mission statement that guides an exploratory test session.

### https://api.glossary.istqb.org/v1/terms/test-condition
- Access: 2026-11-12T14:49:08.083907+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-condition
- Findings: Public glossary API returned English definition (v4): A testable aspect of a component or system that is intended to be tested.

### https://api.glossary.istqb.org/v1/terms/test-data
- Access: 2026-11-12T14:49:08.169082+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-data
- Findings: Public glossary API returned English definition (v3): Data needed for test execution.

### https://api.glossary.istqb.org/v1/terms/test-double
- Access: 2026-11-12T14:49:08.165653+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-double
- Findings: Public glossary API returned English definition (v1): A replacement component invoked by a test object to perform testing.

### https://api.glossary.istqb.org/v1/terms/test-environment
- Access: 2026-11-12T14:49:08.272679+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-environment
- Findings: Public glossary API returned English definition (v1): An environment containing hardware, instrumentation, simulators, software tools, and other support elements needed to perform a test.

### https://api.glossary.istqb.org/v1/terms/test-log
- Access: 2026-11-12T14:49:08.387973+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-log
- Findings: Public glossary API returned English definition (v1): A chronological record of relevant details about test execution.

### https://api.glossary.istqb.org/v1/terms/test-objective
- Access: 2026-11-12T14:49:08.509482+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-objective
- Findings: Public glossary API returned English definition (v3): The purpose for testing.

### https://api.glossary.istqb.org/v1/terms/test-oracle
- Access: 2026-11-12T14:49:08.485913+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-oracle
- Findings: Public glossary API returned English definition (v2): A source to determine an expected result.

### https://api.glossary.istqb.org/v1/terms/test-plan
- Access: 2026-11-12T14:49:08.584556+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-plan
- Findings: Public glossary API returned English definition (v3): Documentation that describes test objectives, means and schedule for achieving test coordination.

### https://api.glossary.istqb.org/v1/terms/test-procedure
- Access: 2026-11-12T14:49:08.688230+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-procedure
- Findings: Public glossary API returned English definition (v1): A sequence of test cases in execution order and any associated actions that may be required to set up the initial preconditions and any wrap-up activities after execution.

### https://api.glossary.istqb.org/v1/terms/test-report
- Access: 2026-11-12T14:49:08.795959+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-report
- Findings: Public glossary API returned English definition (v1): Documentation summarizing testing and test results.

### https://api.glossary.istqb.org/v1/terms/test-result
- Access: 2026-11-12T14:49:08.751990+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-result
- Findings: Public glossary API returned English definition (v2): The status of the execution of a test.

### https://api.glossary.istqb.org/v1/terms/test-run
- Access: 2026-11-12T14:49:08.853702+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-run
- Findings: Public glossary API returned English definition (v1): The execution of a test suite on a specific version of the test object.

### https://api.glossary.istqb.org/v1/terms/test-suite
- Access: 2026-11-12T14:49:08.921756+00:00 — HTTP 200; final URL: https://api.glossary.istqb.org/v1/terms/test-suite
- Findings: Public glossary API returned English definition (v3): A set of test scripts or test procedures to be executed in a specific test run.

### https://docs.docker.com/build/concepts/dockerfile/
- Access: 2026-11-12T14:51:25.831920+00:00 — HTTP 200; final URL: https://docs.docker.com/build/concepts/dockerfile/
- Findings: Supplemental Dockerfile documentation fetched HTTP 200. Used only after reading main content below; explains Dockerfile text instructions for image creation.

### https://docs.docker.com/compose/
- Access: 2026-11-12T14:48:20.127981+00:00 — HTTP 200; final URL: https://docs.docker.com/compose/
- Findings: Compose defines/runs multi-container applications with services, networks and volumes in one YAML configuration file; services can exist before running deployments.

### https://docs.gitlab.com/development/testing_guide/quarantining_tests/
- Access: 2026-11-12T14:48:20.048528+00:00 — HTTP 200; final URL: https://docs.gitlab.com/development/testing_guide/quarantining_tests/
- Findings: Quarantine skips a retained test in CI; metadata links a failure issue and categorizes flaky/bug/broken/environment reasons. Prerequisites explicitly include a test failure issue. Latest run evidence is not required to declare quarantine.

### https://docs.pact.io/
- Access: 2026-11-12T14:48:20.081529+00:00 — HTTP 200; final URL: https://docs.pact.io/
- Findings: Contracts describe concrete messages between a consumer and provider; Pact generates contracts from consumer tests. Contract testing checks each application in isolation. A static OpenAPI specification is not a mandatory predecessor.

### https://dora.dev/guides/dora-metrics/
- Access: 2026-11-12T14:48:19.976605+00:00 — HTTP 200; final URL: https://dora.dev/guides/dora-metrics/
- Findings: Change lead time spans committed change to production deployment. Deployment frequency and failed deployment recovery time distinguish deployments and changes. The page does NOT define release-gate semantics or require all releases to have Git tags; local catalog definitions supply those distinctions.

### https://github.com/in-toto/attestation/blob/main/spec/README.md
- Access: 2026-11-12T14:48:20.493414+00:00 — HTTP 200; final URL: https://github.com/in-toto/attestation/blob/main/spec/README.md
- Findings: Read rendered specification README. Predicate contains metadata; statement binds subject and predicate type; envelope handles authentication/serialization. These are independent layers, supporting subject -> statement -> authenticated attestation fill direction.

### https://github.com/opencontainers/image-spec
- Access: 2026-11-12T14:48:20.567560+00:00 — HTTP 200; final URL: https://github.com/opencontainers/image-spec
- Findings: Read rendered project README (not every linked specification). Image format contains enough information to launch application; registry distribution can provide an image independently of its local build recipe. OCI is not a Dockerfile recipe standard; supplemental Docker documentation accessed.

### https://glossary.istqb.org/en_US/term/capacity-testing
- Access: 2026-11-12T14:48:20.315492+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/capacity-testing
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/coverage
- Access: 2026-11-12T14:48:20.175677+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/coverage
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/defect
- Access: 2026-11-12T14:48:20.244094+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/defect
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/exploratory-testing
- Access: 2026-11-12T14:48:20.261364+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/exploratory-testing
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/failure
- Access: 2026-11-12T14:48:20.434395+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/failure
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/load-testing
- Access: 2026-11-12T14:48:20.601415+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/load-testing
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/performance-testing
- Access: 2026-11-12T14:48:20.664869+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/performance-testing
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-basis
- Access: 2026-11-12T14:48:20.506973+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-basis
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-case
- Access: 2026-11-12T14:48:20.628531+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-case
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-charter
- Access: 2026-11-12T14:48:20.699796+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-charter
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-condition
- Access: 2026-11-12T14:48:20.582387+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-condition
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-data
- Access: 2026-11-12T14:48:20.557961+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-data
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-double
- Access: 2026-11-12T14:48:20.752090+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-double
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-environment
- Access: 2026-11-12T14:48:20.934384+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-environment
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-log
- Access: 2026-11-12T14:48:20.879552+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-log
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-objective
- Access: 2026-11-12T14:48:20.990390+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-objective
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-oracle
- Access: 2026-11-12T14:48:21.034066+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-oracle
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-plan
- Access: 2026-11-12T14:48:21.059616+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-plan
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-procedure
- Access: 2026-11-12T14:48:21.128997+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-procedure
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-report
- Access: 2026-11-12T14:48:20.957764+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-report
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-result
- Access: 2026-11-12T14:48:20.971052+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-result
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-run
- Access: 2026-11-12T14:48:21.075429+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-run
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/en_US/term/test-suite
- Access: 2026-11-12T14:48:21.086450+00:00 — HTTP 200; final URL: https://glossary.istqb.org/en_US/term/test-suite
- Findings: HTTP 200 returns only JavaScript application shell (title ISTQB Glossary), not term text. Read corresponding public /v1/terms/ endpoint below; no successful HTML term rendering claimed.

### https://glossary.istqb.org/index.21d8c286.js
- Access: 2026-11-12T14:48:58.186619+00:00 — HTTP 200; final URL: https://glossary.istqb.org/index.21d8c286.js
- Findings: Read relevant application loader fragments to discover public API base URL https://api.glossary.istqb.org/v1 and GET /terms/{slug}; no browser rendering claimed.

### https://helm.sh/docs/topics/charts/
- Access: 2026-11-12T14:48:21.061921+00:00 — HTTP 200; final URL: https://helm.sh/docs/topics/charts/
- Findings: Charts are collections of files describing related Kubernetes resources; templates plus values generate manifests; chart/appVersion are separate versions. Page warns not fully updated for Helm 4. Catalog has no Helm chart kind, so file plus namespace approximates installation prerequisites.

### https://kubernetes.io/docs/concepts/architecture/controller/
- Access: 2026-11-12T14:48:21.135979+00:00 — HTTP 200; final URL: https://kubernetes.io/docs/concepts/architecture/controller/
- Findings: Controllers compare spec desired state with current state and act to move actual state toward desired. Desired and current states are comparands; neither requires the other to be separately recorded.

### https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- Access: 2026-11-12T14:48:21.204067+00:00 — HTTP 200; final URL: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- Findings: Deployment declares desired Pod state; controller changes actual state at controlled rate. Rollout can pause/resume; rolling updates use maxUnavailable and maxSurge. Kubernetes Deployment object is not identical to generic deployment action.

### https://openfeature.dev/specification/glossary
- Access: 2026-11-12T14:48:21.616020+00:00 — HTTP 200; final URL: https://openfeature.dev/specification/glossary/
- Findings: Provider is SDK-compliant adapter resolving flags from a management system. Flag is a typed pivot; variant names a value; rule assigns a variant; evaluation context holds environment/host/user facts and can be global/shared. Glossary defines flag set simply as related flags, not necessarily one provider/context: local definition is narrower.

### https://opengitops.dev/
- Access: 2026-11-12T14:48:21.349713+00:00 — HTTP 200; final URL: https://opengitops.dev/
- Findings: Read four v1.0 principles: declarative desired state, versioned/immutable history, automatically pulled declarations, continuous observation/reconciliation of actual state. Application/source names are catalog-specific, not formally defined kinds here.

### https://opentelemetry.io/docs/specs/semconv/registry/attributes/cicd/
- Access: 2026-11-12T14:48:21.567700+00:00 — HTTP 200; final URL: https://opentelemetry.io/docs/specs/semconv/registry/attributes/cicd/
- Findings: Pipeline delivers software; pipeline tasks include commands/steps/procedures. Pipeline run has ID/result/state; workers have ID/name/URL and available/busy/offline states. Idle worker identity does not require an executed task. Catalog workflow-file restriction is narrower than telemetry conventions.

### https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
- Access: cached response — HTTP 200; final URL: https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
- Findings: Change ID denotes PR/MR/changelist within repository; ref base/head revision identifies commits or revisions; ref types include branch/tag. Catalog Change spans delivery more broadly than the OTel change-request concept.

### https://principlesofchaos.org/
- Access: 2026-11-12T14:48:21.389924+00:00 — HTTP 200; final URL: https://principlesofchaos.org/
- Findings: Read full principles: define steady state from measurable system outputs; hypothesize it persists; inject realistic events; compare control and experiment. Minimize blast radius; production traffic preferred. Results depend on experiment and its baseline, not vice versa.

### https://raw.githubusercontent.com/mirror/make/master/doc/make.texi
- Access: 2026-11-12T14:51:25.601387+00:00 — HTTP 200; final URL: https://raw.githubusercontent.com/mirror/make/master/doc/make.texi
- Findings: Read rule-introduction source section: target can name a generated file or action; rule has targets/prerequisites/recipe; recipe comprises commands. A clean action may have no file prerequisites. Mirror source is accessible fallback for forbidden GNU manual.

### https://slsa.dev/spec/v1.0/provenance
- Access: 2026-11-12T14:48:21.404883+00:00 — HTTP 200; final URL: https://slsa.dev/spec/v1.0/provenance
- Findings: Read schema and field semantics: buildDefinition supplies parameters/resolvedDependencies; runDetails supplies builder and metadata/byproducts. Subject is output artifact; byproducts are useful non-output artifacts such as logs. builder.id identifies trusted platform boundary, not necessarily an IAM workload account. Local builder-identity kind ambiguously overlaps platform identity.

### https://stryker-mutator.io/docs/
- Access: 2026-11-12T14:48:21.653805+00:00 — HTTP 200; final URL: https://stryker-mutator.io/docs/
- Findings: Read introduction and example: insert deliberate mutations into source code; run tests for each; failing tests kill a mutant, passing tests mean survived; report shows changed source and outcomes. Mutant can be defined before a result.

### https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- Access: 2026-11-12T14:48:21.489810+00:00 — HTTP 200; final URL: https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- Findings: Read article body (comments are not relied on). Flaky means both passing/failing with same code; quarantine removes tests from critical path and files repair bug, potentially hiding real races.

### https://web.dev/articles/performance-budgets-101
- Access: 2026-11-12T14:48:21.603393+00:00 — HTTP 200; final URL: https://web.dev/articles/performance-budgets-101
- Findings: Read definition and metric sections: budgets limit page metrics such as load time/weight/request counts and guide design choices before execution. Tests/measurements assess them later.

### https://web.dev/articles/vitals
- Access: 2026-11-12T14:48:21.784984+00:00 — HTTP 200; final URL: https://web.dev/articles/vitals
- Findings: Read overview, current Core Web Vitals metrics/thresholds, field measurement and lab/field distinctions. User-centric web metrics support repeatable performance measurement, but this page is not a general standard for arbitrary speed/cost benchmarks.

### https://www.gnu.org/software/make/manual/html_node/Rule-Introduction.html
- Access: 2026-11-12T14:48:58.580285+00:00 — HTTP 403; final URL: https://www.gnu.org/software/make/manual/html_node/Rule-Introduction.html
- Findings: HTTP 403 Forbidden; not read.

### https://www.gnu.org/software/make/manual/make.html
- Access: 2026-11-12T14:48:21.625864+00:00 — HTTP 403; final URL: https://www.gnu.org/software/make/manual/make.html
- Findings: HTTP 403 Forbidden. Not read; alternative html_node page also 403. Public source mirror read as fallback, clearly separate from successful access to cited URL.

## Coverage and roots

- 68 kinds: 34 delivery and 34 testing. Exact own-ID coverage verified; all dependency IDs occur in the complete catalog. No owned-subgraph cycle or owned-subgraph redundant direct edge found. Cross-group closure still requires coordinator graph validation.

- `slsa.builder`: The platform is independently identifiable infrastructure; requiring a build or provenance would reverse the producer relationship.
- `practice.container-image`: An externally supplied image is independently identifiable by its registry coordinate; its producers and consumers need not be catalogued.
- `openfeature.provider`: The adapter/source can be named and described without its served flags or callers; requiring those consumers would reverse the dependency.
- `otel.cicd-worker`: The runner machine or agent has independent identity; no pipeline or job execution is needed to describe an idle runner.

## Per-kind decisions

- `slsa.subject` <- `slsa.build`: The catalog defines this specifically as a build output; the producing build identifies what the digest describes, rather than requiring its later release or deployment.
- `slsa.builder` <- []: A build service can be identified by its platform URI and trust boundary before any invocation is recorded. Builds consume this platform identity, not the reverse.
- `slsa.build` <- `practice.commit`, `slsa.builder`: One invocation needs the source revision and the platform that executed it. Artifacts and byproducts are its outputs; requiring them would invert production.
- `slsa.builder-identity` <- `slsa.builder`: The catalog means the identity used by a particular build platform; that platform scopes the identity. SLSA v1 treats builder.id as the platform trust base, not necessarily a workload account; no mandatory IAM account is assumed.
- `slsa.byproduct` <- `slsa.build`: A log or diagnostic artifact is a byproduct only relative to the invocation that emitted it. It is not a prerequisite of that invocation.
- `practice.compose-service` <- `spdx.file`: The service name, ports and dependency declarations come from a Compose file. It need not have a locally built image, Dockerfile or an existing deployment.
- `practice.dockerfile` <- `spdx.file`: The recipe is a particular repository file. The image it can produce is downstream and is not needed to describe the recipe.
- `practice.container-image` <- []: Registry repository plus tag or digest identifies an image, including a third-party image whose source and build are unknown. No local Dockerfile, build or running deployment is required.
- `openfeature.flag` <- `practice.product`: The switch needs the product whose behavior it changes. Providers serve flags but do not define their business identity; variants and targeting rules refine the switch later.
- `openfeature.evaluation-context` <- `practice.product`: Runtime, caller and subject facts belong to the product using flag evaluation. OpenFeature permits shared/global context before a particular flag or targeting rule exists, so neither is required.
- `openfeature.provider` <- []: A provider is independently identifiable as an SDK-compliant adapter to a flag management system. It can be configured before the catalog holds any flag definitions.
- `openfeature.targeting-rule` <- `openfeature.variant`, `openfeature.evaluation-context`: A rule chooses an identified flag variant by applying criteria to evaluation facts. The variant already brings the flag context, so a separate flag edge is redundant.
- `openfeature.flag-set` <- `openfeature.provider`, `openfeature.evaluation-context`: The local definition scopes the collection to a provider and a context. Those define which collection it is; its individual flags are members, not fill prerequisites.
- `openfeature.variant` <- `openfeature.flag`: A value identifier and its type only have meaning for a particular flag. Rules consume variants and therefore must not be prerequisites here.
- `opengitops.application` <- `opengitops.source`, `practice.desired-deployment`: The application ties a Git-held source to a desired deployed state. Reconciliation is subsequent activity; the source revision and desired state already provide repository and deployment context.
- `opengitops.reconciliation` <- `opengitops.application`, `practice.observed-deployment`: Comparison and correction need the managed application with its source/desired state, and the actual state being compared. The desired state is already an application prerequisite.
- `opengitops.source` <- `practice.commit`: Repository/path/revision must identify a particular recorded revision. The commit supplies its repository context; an application that later reads the source is not required.
- `otel.cicd-task` <- `otel.cicd-pipeline`: A job is named and interpreted within its workflow. Its run and worker are later execution facts, not prerequisites for declaring the job.
- `otel.cicd-pipeline` <- `spdx.file`: This catalog kind is the workflow file and its triggers, so the repository file is the nearest source. Jobs are children described later, not prerequisites of the workflow.
- `practice.make-target` <- `spdx.file`: A target and its recipe are read from a particular Makefile. A pipeline or a successful build need not exist to identify that target; the cited GNU manual could not be accessed (403).
- `otel.cicd-pipeline-run` <- `otel.cicd-pipeline`, `practice.commit`: An execution needs the workflow it executes and the revision it runs against. Results, duration and jobs executed are filled as execution facts, not prior conditions.
- `otel.cicd-worker` <- []: OpenTelemetry gives a worker its own ID, name, URL and available/offline state. It can be registered before any pipeline task is assigned.
- `otel.vcs-change` <- `practice.commit`: The local definition starts at the first commit, so an underlying recorded change in repository history is needed. Production deployment is a downstream milestone, not a prerequisite.
- `practice.deployment` <- `practice.release`, `practice.deployment-environment`: Putting a version into a location needs the released version and the target environment. Desired and observed state describe the action afterward and do not precede its identity.
- `practice.desired-deployment` <- `practice.deployment`: The requested state belongs to the deployment that asked for it, which already identifies version and target. GitOps source and observed state are possible evidence/comparands, not universal prerequisites.
- `helm.release` <- `spdx.file`, `kubernetes.namespace`: A named Helm installation needs its chart definition (represented by a repository file; no chart kind exists) and its namespace, which supplies cluster context. It is not synonymous with a product release.
- `practice.observed-deployment` <- `practice.deployment`: This is the platform-reported state for the deployment in its environment. The deployment supplies target/version context; it must not require a desired-state comparison to record actual state.
- `practice.release-gate` <- `practice.release`, `istqb.acceptance-criterion`: A gate applies an acceptance condition to a release before promotion. It can be defined before test runs or deployments and need not consume a particular test-report kind.
- `practice.release` <- `otel.vcs-change`: The released product version is described through the changes it carries. Those commits already lead to repository/product context; neither tags nor a particular artifact format is universally required.
- `practice.rollout` <- `practice.desired-deployment`: The staged replacement strategy refines the state requested for a deployment. Pauses and surge/unavailable limits govern reaching that state; the observed outcome comes later.
- `practice.tag` <- `practice.commit`: A tag fixes a name to an identified revision. It is not a release and does not require a build or release consumer.
- `in-toto.attestation` <- `in-toto.statement`: The authenticated envelope wraps a statement. That statement already supplies the subject artifact, so repeating a subject edge is unnecessary; provenance is only one possible predicate.
- `in-toto.statement` <- `slsa.subject`: A statement binds a typed predicate to an identified subject artifact. The attestation authenticates it later and is not a prerequisite of the enclosed claim.
- `slsa.provenance` <- `slsa.subject`: The record explains the production of a digest-identified output artifact; that subject already leads to its producing build and platform. An envelope or attestation is a later authentication wrapper, not a prerequisite.
- `istqb.test-case` <- `istqb.test-condition`, `spdx.file`: ISTQB derives test inputs/actions/expected results from test conditions. This catalog narrows the case to an extracted test and exercised code, so its repository file is also needed; suite and run are consumers.
- `practice.test-quarantine` <- `istqb.test-case`, `practice.product-task`, `practice.commit`: Quarantine identifies an excluded test, its repair work item and the introducing revision. File context already follows from the test case; latest CI result is explicitly optional. The catalog product-task is used, not the obsolete unqualified task reference.
- `istqb.coverage-item` <- `istqb.test-basis`: A coverage item selects a particular aspect of the test basis to measure. A suite or measured percentage is a consumer/result and is not required to identify the branch or requirement to cover.
- `istqb.test-basis` <- `practice.product`: The body of knowledge must have a product scope but can come from code, requirements, stories or expert knowledge. No one such alternative source kind is mandatory, and conditions/tests are derived downstream.
- `istqb.test-condition` <- `istqb.test-basis`: A testable aspect is selected by analyzing the body of knowledge. Test cases elaborate the condition; requiring them would reverse the test-design flow.
- `istqb.test-data` <- `istqb.test-condition`: Input data is selected for the aspect to exercise. It can be prepared before concrete cases or runs and remains separate from code; the condition provides the nearest test intent.
- `istqb.test-double` <- `backstage.component`: A replacement must identify the component whose behavior or interface it stands in for. Cases consume the stand-in; requiring a case would make test construction unnecessarily circular.
- `istqb.test-oracle` <- `istqb.test-basis`: An expected-result source is selected from the knowledge of intended behavior. A test case consumes the oracle; golden files and written specifications are alternatives, not simultaneous mandatory kinds.
- `istqb.test-procedure` <- `istqb.test-case`: Ordering cases and defining setup/wrap-up needs identified cases. The procedure precedes execution and does not require a test run or log.
- `istqb.test-suite` <- `istqb.test-case`, `istqb.test-environment`: The local definition groups cases for execution and names their required environment. Cases do not require the containing suite, so this aggregation direction is acyclic; runs consume the suite.
- `istqb.defect` <- `practice.product`: A deficiency needs the affected work-product context, but can occur in code, requirements, documentation or design. Product identity is the common available prerequisite; neither a failing test nor an observed failure is mandatory (static review can find defects).
- `istqb.failure` <- `iso29148.requirement`: A failure records an execution event that misses specified behavior or limits. The requirement establishes what was violated; a diagnosed defect or test result may follow and is not required to observe a failure.
- `istqb.test-charter` <- `istqb.test-objective`: The exploratory mission turns a testing purpose into a bounded direction for exploration. A session executes that mission later and is not required to write it.
- `istqb.test-environment` <- `practice.technology`: The hardware/software/tool environment needs the technologies that specify its support elements. An actual test or suite is a consumer; requiring those would prevent preparing the environment first.
- `istqb.test-objective` <- `istqb.test-basis`: A testing purpose must be grounded in knowledge of the product and what needs assurance. It need not wait for a plan, charter or a concrete test that will serve it.
- `istqb.test-plan` <- `istqb.test-objective`: Objectives supply the purpose around which means and schedule are organized. Suites, execution logs and reports are planned or produced later, not inputs needed to identify the plan.
- `istqb.test-session` <- `istqb.test-charter`, `istqb.test-environment`: A bounded exploratory period needs its guiding mission and a usable test environment. It can discover/design cases dynamically, so no prewritten suite or case list is forced.
- `practice.flaky-test` <- `istqb.test-result`: Different outcomes for the same code require recorded executions, not just a test declaration. A result already identifies its case/run/revision, so those edges need not be repeated; quarantine is only a possible response.
- `practice.mutant` <- `spdx.file`: A deliberately changed copy needs the original source file. Tests later try to kill it; neither an outcome nor a mutation report is needed to identify the mutation.
- `practice.mutation-report` <- `practice.mutant`, `istqb.test-result`: A kill/survival report needs identified deliberate changes and test execution outcomes. The outcomes already supply case/suite/run context; mutants must not depend on this consuming report.
- `istqb.test-log` <- `istqb.test-run`: A chronological execution record needs the run it records. Individual results can arrive during that run, but are not prerequisites to start recording the log.
- `istqb.test-report` <- `istqb.test-result`: Summarizing passed, failed and blocked testing requires recorded outcomes. Each outcome already supplies its run and case; the report is not a prerequisite of execution.
- `istqb.test-result` <- `istqb.test-run`: An outcome belongs to a run whose suite already identifies the cases. It records a particular case selection within that scope; failures are optional outcomes, not mandatory prerequisites.
- `istqb.test-run` <- `istqb.test-suite`, `practice.commit`: An execution needs the suite and the exact tested version. A commit represents that version without forcing a user release before tests can run.
- `practice.benchmark` <- `practice.product`, `istqb.test-environment`: A repeatable speed/cost measurement needs its product target and controlled measurement environment. A budget is a possible comparator, not mandatory for establishing an initial baseline; Web Vitals only supports the web-performance subset.
- `practice.capacity-test` <- `istqb.performance-test`: Capacity testing specializes a performance test to finding the load limit. The underlying performance test already supplies test intent and environment; no separate load-test kind is required.
- `practice.chaos-experiment` <- `practice.observed-deployment`, `sre.sli`: A controlled fault needs an identified running target and measurable steady-state behavior. Actual deployment and an SLI supply these without requiring a result or an incident in advance.
- `practice.chaos-result` <- `practice.chaos-experiment`: The findings need the controlled experiment, which already identifies target and steady-state measure. Its result must not be required by the experiment it evaluates.
- `pact.consumer-contract` <- `practice.integration`: Consumer expectations concern a particular integration between consumer and provider. That integration supplies participants/protocol; a static interface specification is not required because Pact contracts can be generated from examples.
- `pact.contract-test` <- `pact.consumer-contract`: A compatibility check needs the consumer expectations it checks. Provider verification is a run of that check and therefore downstream.
- `practice.load-test` <- `istqb.performance-test`: Expected/typical/peak load specializes the performance test. The general test already brings its cases and environment; a benchmark or production deployment is not universally required.
- `practice.performance-budget` <- `practice.screen`: The local definition limits a screen or route, so the rendered screen is the scope for metric limits. Performance tests consume the budget later; an existing measurement is not needed to set a target.
- `istqb.performance-test` <- `istqb.test-case`, `istqb.test-environment`: The performance test needs a defined exercise/expected behavior and a controlled environment to give response and capacity measurements meaning. A budget or baseline benchmark can be added but is not necessary for measurement.
- `pact.provider-verification` <- `pact.contract-test`, `istqb.test-environment`: The recorded provider-check run needs the contract test to execute and the environment hosting the provider. The contract test already leads to published consumer expectations and the integration.

---

## Review batch 6

# Dependency proposal source evidence: costs, ml, rd

Task: madarch-64o5.28. Access date: 2026-11-12. Proposal only; no repository files edited.

Read the entire catalog JSON and all 30 assigned YAML definitions/descriptions. 30 proposals, 36 edges, no roots. Dependencies are nearest conceptual prerequisites, not normative relationships asserted by these standards. No package installs. HTTP fetched with requests and cached by SHA-256 URL under `/tmp/derives-standard-cache`.

## Access and meaning

### https://adr.github.io/
- Access: 200; final URL: https://adr.github.io/; date: 2026-11-12.
- Findings and limits: Defines an architectural decision as a justified design choice addressing an architecturally significant functional or nonfunctional requirement; ADR captures one choice and rationale. Supports the decision/log distinction.

### https://adr.github.io/madr/
- Access: 200; final URL: https://adr.github.io/madr/; date: 2026-11-12.
- Findings and limits: Read embedded full template: context/problem statement, optional drivers (forces/facing concerns), considered options, chosen outcome and justification, optional consequences and confirmation. Drivers can exist before decisions; option accept/reject rationale refers to the decision outcome.

### https://arc42.org/overview
- Access: 200; final URL: https://arc42.org/overview/; date: 2026-11-12.
- Findings and limits: Section 11 covers known risks and technical debt; section 9 important decisions. Overview alone does not prescribe a dependency graph.

### https://cyclonedx.org/docs/1.6/json/
- Access: 200; final URL: https://cyclonedx.org/docs/1.6/json/; date: 2026-11-12.
- Findings and limits: Read machine-learning-model component type and modelCard/modelParameters definitions. Model based on training data; model card describes intended uses, limitations, training parameters, datasets and performance metrics. No universal requirement for a separately captured training run; that edge interprets the stronger local definition.

### https://en.wikipedia.org/wiki/Hypothesis
- Access: 403; final URL: https://en.wikipedia.org/wiki/Hypothesis; date: 2026-11-12.
- Findings and limits: HTTP 403 robot-policy denial. No article read. Hypothesis prerequisites are local-definition interpretation, with Scrum providing only general empirical context.

### https://en.wikipedia.org/wiki/Spike_(software_development)
- Access: 403; final URL: https://en.wikipedia.org/wiki/Spike_(software_development); date: 2026-11-12.
- Findings and limits: HTTP 403 robot-policy denial. No article read. Spike prerequisite is inferred from the local question-before-decision definition, not verified against this article.

### https://focus.finops.org/
- Access: 200; final URL: https://focus.finops.org/; date: 2026-11-12.
- Findings and limits: Read landing description: normalizes billing datasets across cloud, AI, SaaS, data-center and other vendors. Costs are not restricted to infrastructure resources. Followed specification link.

### https://mlflow.org/docs/latest/index.html
- Access: 200; final URL: https://mlflow.org/docs/latest/index.html; date: 2026-11-12.
- Findings and limits: Read documentation gateway only: separates LLM/agent and traditional ML tracking/evaluation. Followed focused tracking and evaluation docs; gateway itself supplies little detail.

### https://openfeature.dev/specification/glossary
- Access: 200; final URL: https://openfeature.dev/specification/glossary/; date: 2026-11-12.
- Findings and limits: Read flagging terms: conditional alternative code paths, variant values, evaluation context, targeting and fractional evaluation. This is not a general experimental-method standard; it does not justify requiring feature flags for every experiment or A/B test.

### https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Access: 200; final URL: https://opentelemetry.io/docs/specs/semconv/gen-ai/; date: 2026-11-12.
- Findings and limits: Page explicitly says conventions moved and is no longer maintained. Followed the named new repository using raw documented pages. Original is a moved notice, not a current token-accounting specification.

### https://scrumguides.org/scrum-guide.html
- Access: 200; final URL: https://scrumguides.org/scrum-guide.html; date: 2026-11-12.
- Findings and limits: Read empiricism, inspection and adaptation sections: experience/observations inform decisions, inspect progress toward goals, adapt based on findings. Supports benefit validation context but does not prescribe a hypothesis kind or prerequisite graph.

### https://spdx.github.io/spdx-spec/v3.0.1/model/AI/
- Access: 200; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/AI/; date: 2026-11-12.
- Findings and limits: HTML redirect stub only; followed displayed AI/AI/ destination.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Dataset/
- Access: 200; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/Dataset/; date: 2026-11-12.
- Findings and limits: HTML redirect stub only; followed displayed Dataset/Dataset/ destination.

### https://www.nist.gov/itl/ai-risk-management-framework
- Access: 200; final URL: https://www.nist.gov/itl/ai-risk-management-framework; date: 2026-11-12.
- Findings and limits: Read framework introduction: manage risks to individuals, organizations and society; trustworthiness across design/development/use/evaluation of AI products/services/systems. Does not itself define a model-card schema; model-card detail checked in CycloneDX. System-specific risks/impacts/incidents refer to the AI subject; risk assessment and incident discovery need not wait for one another.

### https://www.nngroup.com/articles/paper-prototyping/
- Access: 200; final URL: https://www.nngroup.com/articles/paper-prototyping/; date: 2026-11-12.
- Findings and limits: Read article: inexpensive early design ideas can be user-tested before implementation; multiple paper mockups reveal usability problems and inform design direction. Does not require code files, completed ADRs, or a separately recorded formal hypothesis. Proposed hypothesis edge is a catalogue abstraction of the expectation explored, not a normative NN/G requirement.

### https://www.tensorflow.org/tfx/ml_metadata/api_docs/python/mlmd
- Access: 200; final URL: https://www.tensorflow.org/tfx/ml_metadata/api_docs/python/mlmd; date: 2026-11-12.
- Findings and limits: Read API main content: module initializes ML Metadata; MetadataStore stores metadata, ListOptions lists nodes. API gateway has little provenance explanation; followed MLMD guide.

### https://focus.finops.org/docs/specification/v1-4/
- Access: 200; final URL: https://focus.finops.org/docs/specification/v1-4/; date: 2026-11-12.
- Findings and limits: Read publication status and abstract plus column/section outline. FOCUS common billing schema supports allocation, budgeting and forecasting. Outline includes Billed Cost, Billing Currency, Charge Period, Resource ID/Name/Type, service/provider identity and split allocation handling. The fetched page does not contain all column body text; no claim of reading every subpage. Budget need not wait for spend; forecast explicitly uses historical spend in local definition.

### https://spdx.github.io/spdx-spec/v3.0.1/model/AI/AI/
- Access: 200; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/AI/AI/; date: 2026-11-12.
- Findings and limits: Read AI profile body: documents AI software systems/model artifacts; development outputs include software packages, models, datasets. Conformance requires declared and concluded licence relationships for AIPackage. This profile does not demand that all model training runs be known.

### https://spdx.github.io/spdx-spec/v3.0.1/model/Dataset/Dataset/
- Access: 200; final URL: https://spdx.github.io/spdx-spec/v3.0.1/model/Dataset/Dataset/; date: 2026-11-12.
- Findings and limits: Read Dataset profile body: preparation, characteristics and access metadata layered on Software profile; DatasetPackage requires declared and concluded licence relationships. Supports identified data plus licence rather than a model consumer as prerequisite.

### https://www.tensorflow.org/tfx/guide/mlmd
- Access: 200; final URL: https://www.tensorflow.org/tfx/guide/mlmd; date: 2026-11-12.
- Findings and limits: Read MLMD conceptual guide and worked example: register data artifact; create trainer execution; record declared input event; declare output SavedModel artifact; record output event; complete execution. Distinguishes input dataset and training execution from generated model, preventing output-to-execution feedback.

### https://mlflow.org/docs/latest/ml/tracking/
- Access: 200; final URL: https://mlflow.org/docs/latest/ml/tracking/; date: 2026-11-12.
- Findings and limits: Read tracking concepts and examples: runs execute data-science code, record parameters/metrics/artifacts; models are trained artifacts produced during runs; experiments group runs/models. Training-run code and data are inputs, model an output.

### https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md
- Access: 200; final URL: https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md; date: 2026-11-12.
- Findings and limits: Read maintained GenAI spans document (raw Markdown). Specifies GenAI client operations, content capture and operation telemetry; token/model attributes expanded in the registry follow-up. Money is not implied by token counts alone and remains local usage-record data.

### https://docs.arc42.org/section-11/
- Access: 200; final URL: https://docs.arc42.org/section-11/; date: 2026-11-12.
- Findings and limits: Read section 11 body and practical tips: prioritize identified technical risks/debts, evaluate architecture problems with stakeholders, interfaces, processes, data and source. No requirement that every debt have a TODO or a prior separate risk record.

### https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/registry/attributes/gen-ai.md
- Access: 200; final URL: https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/registry/attributes/gen-ai.md; date: 2026-11-12.
- Findings and limits: Read GenAI attributes registry including gen_ai.request.model, gen_ai.response.model and gen_ai.usage.input_tokens/output_tokens descriptions. Identifies model used and token measurements. No obligation to create an aggregate cost record first.

### https://mlflow.org/docs/latest/ml/evaluation/
- Access: 200; final URL: https://mlflow.org/docs/latest/ml/evaluation/; date: 2026-11-12.
- Findings and limits: Read evaluation introduction and examples: evaluate models/functions/static datasets, metrics/plots/diagnostics, custom criteria; separates classic and GenAI evaluation APIs. Local kind means model against dataset; evaluation output comes after execution. Evaluation data are not necessarily training data.

## Assumptions and review concerns

- Each list is conjunction, not a union of every possible target. Cost allocation destinations are polymorphic, so no mandatory team/service edge. General cost records use product context rather than demand cloud infrastructure for all charges.
- The local trained-model definition includes generating data/code, so model depends on training execution. Imported opaque models may not provide this provenance. If the owner intends inventory-only opaque models, this edge should be relaxed, and LLM usage / AI system should not inherit an impossible fill requirement.
- Model card requires evaluation-result because the local definition explicitly includes evaluation. A pre-evaluation draft card would require only model identity instead.
- MADR drivers are optional template sections, but a justified decision still needs a force/concern. The driver kind represents that concern; it does not require a formal ASR. Considered-option is retrospective outcome-specific, so it depends on decision, not the reverse.
- Prototype -> hypothesis and spike -> decision-driver are interpretive mappings: source articles do not require those formal records. They capture the expectation/question before exploration without making either investigation depend on a future decision. Owner review should decide whether informal questions can live only as attributes instead.
- No new constants or repository fields changed. No roots were proposed: every assigned kind describes an already identified subject, an input execution, or evidence of a prior concern.
- No goal/requirement feedback was introduced. Cross-worker cycle check still belongs to parent fan-in, notably product/goal/stakeholder/component/dataset/licence prerequisites.
