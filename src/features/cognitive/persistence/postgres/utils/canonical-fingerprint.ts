import { createHash } from "node:crypto";

export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot canonically serialize non-finite number: ${value}`,
      );
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function" ||
    value === undefined
  ) {
    throw new Error(`Unsupported type for canonical JSON: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => canonicalJsonStringify(item));
    return `[${serializedItems.join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const serializedEntries = keys.map((key) => {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (
        propertyValue === undefined ||
        typeof propertyValue === "function" ||
        typeof propertyValue === "symbol"
      ) {
        throw new Error(
          `Unsupported property value for key "${key}" during canonical JSON serialization`,
        );
      }
      return `${JSON.stringify(key)}:${canonicalJsonStringify(propertyValue)}`;
    });
    return `{${serializedEntries.join(",")}}`;
  }

  throw new Error("Unexpected value during canonical JSON serialization");
}

export function computeCanonicalFingerprint(value: unknown): string {
  const canonicalString = canonicalJsonStringify(value);
  const hash = createHash("sha256")
    .update(canonicalString, "utf8")
    .digest("hex");
  return `sha256:${hash}`;
}
