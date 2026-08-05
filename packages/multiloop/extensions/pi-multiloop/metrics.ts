export interface ConfidenceResult {
  median: number;
  mad: number;
  confidence: "high" | "medium" | "low";
  measurements: number[];
  isSignificant: boolean;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function medianAbsoluteDeviation(values: number[]): number {
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

export function assessConfidence(measurements: number[]): ConfidenceResult {
  if (measurements.length === 0) {
    throw new Error("At least one measurement is required");
  }

  if (measurements.length < 2) {
    return {
      median: measurements[0],
      mad: 0,
      confidence: "low",
      measurements,
      isSignificant: false,
    };
  }

  const med = median(measurements);
  const mad = medianAbsoluteDeviation(measurements);

  let confidence: "high" | "medium" | "low";
  if (mad === 0 || measurements.length >= 5) {
    confidence = "high";
  } else if (measurements.length >= 3) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return { median: med, mad, confidence, measurements, isSignificant: true };
}

export function isImprovement(
  baseline: number,
  current: number,
  mad: number,
  direction: "lower" | "higher",
  threshold: number = 2.0
): boolean {
  const delta = direction === "lower"
    ? baseline - current
    : current - baseline;

  if (mad === 0) {
    return delta > 0;
  }

  return delta > threshold * mad;
}


export function formatDelta(
  baseline: number,
  current: number,
  direction: "lower" | "higher"
): string {
  const diff = current - baseline;
  if (diff === 0) {
    return "0 (unchanged)";
  }
  const pct = baseline !== 0
    ? ` (${((diff / Math.abs(baseline)) * 100).toFixed(1)}%)`
    : "";
  const arrow = direction === "lower"
    ? (diff < 0 ? "improved" : "regressed")
    : (diff > 0 ? "improved" : "regressed");
  return `${diff >= 0 ? "+" : ""}${diff.toFixed(4)}${pct} — ${arrow}`;
}

export function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  switch (confidence) {
    case "high": return "HIGH";
    case "medium": return "MED";
    case "low": return "LOW";
  }
}
