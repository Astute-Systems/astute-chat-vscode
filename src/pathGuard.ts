import * as path from "path";

const SENSITIVE = [/(^|[\\/])\.git([\\/]|$)/, /(^|[\\/])\.env(\.|$)/i, /(^|[\\/])\.ssh([\\/]|$)/, /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)$/, /\.(pem|key|p12|pfx|keystore)$/i, /(^|[\\/])\.(npmrc|netrc)$/];

export function isSensitivePath(filePath: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(filePath));
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
