/** Hybrid and high-core CPUs slow down sharply when llama.cpp uses every core. */
const MIN_CORES_TO_LIMIT = 12;

export function countPhysicalCores(cpuinfo: string): number {
  const cores = new Set<string>();
  let physicalId = "0";
  for (const line of cpuinfo.split("\n")) {
    const match = line.match(/^(physical id|core id)\s*:\s*(\d+)/);
    if (match?.[1] === "physical id") {
      physicalId = match[2];
    } else if (match) {
      cores.add(`${physicalId}:${match[2]}`);
    }
  }
  return cores.size;
}

/**
 * Uses two thirds of the cores on large CPUs. On a 24-core Core Ultra 9 275HX,
 * 16 threads ran at about 16 tokens/s and 24 threads at about 5 tokens/s.
 * Smaller CPUs keep Ollama's own default.
 */
export function autoThreadCount(physicalCores: number): number | undefined {
  return physicalCores >= MIN_CORES_TO_LIMIT ? Math.round((physicalCores * 2) / 3) : undefined;
}
