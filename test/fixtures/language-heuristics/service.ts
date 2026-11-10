export const retries = 3;
export function attempt(n: number): number {
  return n < retries ? n + 1 : retries;
}
