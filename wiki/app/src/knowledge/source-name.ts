/** Human-readable names for the standards and practices cited by kind manifests. */
export function sourceName(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { return source; }
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname;
  const rfc = host === 'rfc-editor.org' && /\/rfc(\d+)/.exec(path);
  if (rfc) return `RFC ${rfc[1]}`;
  if (host === 'standards.ieee.org') {
    const number = /\/ieee\/(\d+)/.exec(path)?.[1];
    if (number) return number === '29148' ? 'ISO/IEC/IEEE 29148' : `IEEE ${number}`;
  }
  if (host === 'omg.org') return `OMG ${path.split('/').filter(Boolean)[1] ?? 'specifications'}`;
  if (host === 'w3.org' && path.startsWith('/TR/')) return `W3C ${path.split('/')[2]}`;
  if (host === 'csrc.nist.gov') {
    const publication = /\/pubs\/sp\/([^/]+)/.exec(path)?.[1];
    return publication ? `NIST SP ${publication}` : 'NIST';
  }
  if (host === 'github.com') {
    const project = path.split('/').filter(Boolean).slice(0, 2).join('/');
    const names: Record<string, string> = {
      'OWASP/ASVS': 'OWASP ASVS', 'in-toto/attestation': 'in-toto attestations',
      'opencontainers/image-spec': 'OCI Image Specification', 'openvex/spec': 'OpenVEX',
      'ossf/scorecard': 'OpenSSF Scorecard', 'shady2k/madarch': 'Madarch',
    };
    return names[project] ?? source;
  }
  const names: Record<string, string> = {
    'c4model.com': 'C4 model', 'arc42.org': 'arc42', 'backstage.io': 'Backstage',
    'spdx.github.io': 'SPDX', 'diataxis.fr': 'Diátaxis', 'scrumguides.org': 'Scrum Guide',
    'support.atlassian.com': 'Atlassian', 'atlassian.com': 'Atlassian',
    'cucumber.io': 'Gherkin', 'adr.github.io': path.startsWith('/madr') ? 'MADR' : 'Architecture Decision Records',
    'spec.openapis.org': 'OpenAPI', 'asyncapi.com': 'AsyncAPI', 'spec.graphql.org': 'GraphQL',
    'json-schema.org': 'JSON Schema', 'protobuf.dev': 'Protocol Buffers',
    'pubs.opengroup.org': path.includes('archimate') ? 'ArchiMate' : path.includes('togaf') ? 'TOGAF' : 'The Open Group', 'opentelemetry.io': 'OpenTelemetry',
    'glossary.istqb.org': 'ISTQB Glossary', 'iso.org': 'ISO', 'committee.iso.org': 'ISO',
    'cwe.mitre.org': 'CWE', 'cyclonedx.org': 'CycloneDX', 'owasp.org': 'OWASP',
    'community.owasp.org': 'OWASP', 'docs.oasis-open.org': path.startsWith('/sarif') ? 'SARIF' : path.startsWith('/cti/stix') ? 'STIX' : path.startsWith('/security/saml') ? 'SAML' : path.startsWith('/xliff') ? 'XLIFF' : 'OASIS',
    'docs.github.com': 'GitHub', 'git-scm.com': 'Git', 'docs.docker.com': path.startsWith('/compose') ? 'Docker Compose' : 'Docker',
    'kubernetes.io': 'Kubernetes', 'developer.hashicorp.com': 'Terraform',
    'helm.sh': 'Helm', 'sre.google': 'Google SRE', 'dora.dev': 'DORA',
    'gdpr-info.eu': 'GDPR', 'nngroup.com': 'Nielsen Norman Group',
    'domainlanguage.com': 'Domain-Driven Design', 'slsa.dev': 'SLSA',
    'ossf.github.io': 'OSV', 'pages.nist.gov': 'NIST OSCAL', 'nist.gov': 'NIST',
    'martinfowler.com': 'Martin Fowler', 'openfeature.dev': 'OpenFeature',
    'openlineage.io': 'OpenLineage', 'opengitops.dev': 'OpenGitOps',
    'keepachangelog.com': 'Keep a Changelog', 'designtokens.org': 'Design Tokens',
    'unicode.org': 'Unicode', 'messageformat.unicode.org': 'Unicode MessageFormat',
    'prometheus.io': 'Prometheus', 'grafana.com': 'Grafana', 'docs.pact.io': 'Pact',
    'storybook.js.org': 'Storybook', 'w3c.github.io': 'W3C', 'web.dev': 'web.dev',
  };
  return names[host] ?? source;
}
