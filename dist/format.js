// Brazilian Portuguese number, size and date formatting shared by the studio pages.
const number = (n, digits) =>
  new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(n);
export function bytes(n) {
  if (n < 1024) return number(n, 0) + " B";
  if (n < 1024 ** 2) return number(n / 1024, 0) + " KB";
  if (n < 1024 ** 3) return number(n / 1024 ** 2, 1) + " MB";
  return number(n / 1024 ** 3, 2) + " GB";
}
export const seconds = (n, digits = 1) => number(n, digits) + " s";
export const plural = (n, one, many) =>
  number(n, 0) + " " + (n === 1 ? one : many);
// "2026-10-27" (a calendar day, not an instant) to "27/10/2026" without timezone shifts.
export function day(value) {
  const [y, m, d] = String(value).split("-");
  return d && m && y ? `${d}/${m}/${y}` : String(value);
}
