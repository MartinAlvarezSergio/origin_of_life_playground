const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹"
};

export function superscript(n: number): string {
  return String(n)
    .split("")
    .map((ch) => SUPERSCRIPT[ch] ?? ch)
    .join("");
}

/** Significant figures without falling back to exponent notation (480, not 4.8e+2). */
export function sig(value: number, digits = 2): string {
  return Number(value.toPrecision(digits)).toLocaleString("en-US");
}

/** "3.2 × 10¹⁵", or a plain number when it is readable as one. */
export function formatScientific(value: number, digits = 2): string {
  if (value === 0) {
    return "0";
  }
  let exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp >= -2 && exp <= 4) {
    return value.toLocaleString("en-US", { maximumSignificantDigits: digits });
  }
  let mantissa = Number((value / 10 ** exp).toFixed(digits - 1));
  // Rounding can carry over (9.97 → 10.0): move it into the exponent.
  if (Math.abs(mantissa) >= 10) {
    mantissa /= 10;
    exp += 1;
  }
  const m = mantissa.toFixed(digits - 1);
  if (m === "1" || m === "1.0") {
    return `10${superscript(exp)}`;
  }
  return `${m} × 10${superscript(exp)}`;
}
