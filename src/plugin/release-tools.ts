/** Release-approved executable bytes. A different distribution needs a new reviewed release pin. */
import type { TrustedTool } from './tools.js';

const LINUX_GIT: TrustedTool = {
  executable: '/usr/bin/git',
  sha256: 'eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201',
};

export function releaseTools(platform = process.platform): Readonly<Record<string, TrustedTool>> {
  return platform.startsWith('linux') ? { git: LINUX_GIT } : {};
}
