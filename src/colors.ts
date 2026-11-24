/**
 * Mural sticky-note background colours are 8-digit hex (#RRGGBBAA).
 * Accept friendly names, #RGB, #RRGGBB or #RRGGBBAA and normalise.
 */
const NAMED: Record<string, string> = {
  yellow: "#FCFE7DFF",
  "light yellow": "#FFFDBAFF",
  orange: "#FFB95FFF",
  "light orange": "#FFD9A3FF",
  red: "#FF7A7AFF",
  pink: "#FFB6E1FF",
  purple: "#CEB4FFFF",
  blue: "#8ED6FFFF",
  "light blue": "#C5E9FFFF",
  green: "#9BF29BFF",
  "light green": "#D1F7C4FF",
  teal: "#7FE3D9FF",
  gray: "#D9D9D9FF",
  grey: "#D9D9D9FF",
  white: "#FFFFFFFF",
  black: "#1F1F1FFF",
};

export function normalizeColor(input: string): string {
  const raw = input.trim();
  const lower = raw.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];

  const hex = lower.startsWith("#") ? lower.slice(1) : lower;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    const [r, g, b] = hex.split("");
    return `#${r}${r}${g}${g}${b}${b}FF`.toUpperCase();
  }
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}FF`.toUpperCase();
  if (/^[0-9a-f]{8}$/.test(hex)) return `#${hex}`.toUpperCase();

  throw new Error(
    `Unrecognised colour "${input}". Use a name (${Object.keys(NAMED).join(", ")}) or hex #RRGGBB / #RRGGBBAA.`,
  );
}

export const NAMED_COLORS = Object.keys(NAMED);
