/** Line of a serialized value, or line one when it is absent. */
export function jsonValueLine(source: string, value: string): number {
  const offset = source.indexOf(JSON.stringify(value));
  return offset < 0 ? 1 : source.slice(0, offset).split("\n").length;
}

/** Source locations for entries of a root object's JSON array. Call after JSON.parse. */
export function jsonArrayLocations(source: string, property = 'files'): { entryLine: number; propertyLines: Record<string, number> }[] {
  let offset = 0;
  let line = 1;
  const advance = (): string => {
    const char = source[offset++]!;
    if (char === '\n') line += 1;
    return char;
  };
  const whitespace = (): void => {
    while (' \n\r\t'.includes(source[offset] ?? '\0')) advance();
  };
  const string = (): string => {
    const start = offset;
    advance();
    while (offset < source.length) {
      const char = advance();
      if (char === '\\') advance();
      else if (char === '"') break;
    }
    return JSON.parse(source.slice(start, offset)) as string;
  };
  const locations: { entryLine: number; propertyLines: Record<string, number> }[] = [];
  const value = (root = false, entries = false, properties?: Record<string, number>): void => {
    whitespace();
    const char = source[offset];
    if (char === '{') {
      advance();
      whitespace();
      while (source[offset] !== '}') {
        const keyLine = line;
        const key = string();
        if (properties) properties[key] = keyLine;
        whitespace();
        advance(); // colon
        value(false, root && key === property);
        whitespace();
        if (source[offset] !== ',') break;
        advance();
        whitespace();
      }
      advance();
    } else if (char === '[') {
      advance();
      whitespace();
      while (source[offset] !== ']') {
        const location = { entryLine: line, propertyLines: {} };
        if (entries) locations.push(location);
        value(false, false, entries ? location.propertyLines : undefined);
        whitespace();
        if (source[offset] !== ',') break;
        advance();
        whitespace();
      }
      advance();
    } else if (char === '"') string();
    else {
      while (offset < source.length && !' \n\r\t,]}'.includes(source[offset]!)) advance();
    }
  };
  value(true);
  return locations;
}
