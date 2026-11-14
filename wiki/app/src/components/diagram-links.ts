/** The page a pressed diagram node opens: the server's own link map, by the element id the renderer reports. */
export function linkOfNode(links: Readonly<Record<string, string>>, node: { readonly id?: unknown; readonly modelRef?: unknown }): string | undefined {
  const byModel = typeof node.modelRef === 'string' ? links[node.modelRef] : undefined;
  if (byModel !== undefined) return byModel;
  return typeof node.id === 'string' ? links[node.id] : undefined;
}
