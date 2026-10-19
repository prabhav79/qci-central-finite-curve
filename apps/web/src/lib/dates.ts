const TZ = "Asia/Kolkata";

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dateTimeWithYearFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const yearFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, year: "numeric" });

/** API timestamps are UTC; a value without an offset is treated as UTC too. */
export function parseApiDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(hasZone || dateOnly ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "17 Oct, 3:00 pm" (adds the year when it isn't the current one). */
export function formatDateTimeIST(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  if (!d) return "";
  const sameYear = yearFmt.format(d) === yearFmt.format(new Date());
  return (sameYear ? dateTimeFmt : dateTimeWithYearFmt).format(d);
}

/** "17 Oct 2026" */
export function formatDateIST(value: string | Date | null | undefined): string {
  const d = value instanceof Date ? value : parseApiDate(value);
  return d ? dateFmt.format(d) : "";
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago", else the date. */
export function formatAgeIST(value: string | null | undefined): string {
  const d = parseApiDate(value);
  if (!d) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDateIST(d);
}
