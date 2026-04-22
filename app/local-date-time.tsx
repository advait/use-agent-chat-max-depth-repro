import { useSyncExternalStore, type ComponentPropsWithoutRef } from "react";

const DEFAULT_LOCALE = "en-US";
const HYDRATED_ON_CLIENT = true;
const HYDRATED_ON_SERVER = false;
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

type DateValueKind = "calendar-date" | "instant";

interface LocalDateTimeProps extends Omit<
  ComponentPropsWithoutRef<"time">,
  "children" | "dateTime"
> {
  readonly fallback?: string;
  readonly formatOptions: Intl.DateTimeFormatOptions;
  readonly value: string;
  readonly valueKind?: DateValueKind;
}

function subscribeToHydration() {
  return () => {};
}

function useHasHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => HYDRATED_ON_CLIENT,
    () => HYDRATED_ON_SERVER,
  );
}

function getFormatter(options: Intl.DateTimeFormatOptions) {
  const cacheKey = JSON.stringify(options);
  const cachedFormatter = FORMATTER_CACHE.get(cacheKey);

  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, options);

  FORMATTER_CACHE.set(cacheKey, formatter);

  return formatter;
}

function parseCalendarDate(value: string) {
  const match = CALENDAR_DATE_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localDate = new Date(year, month - 1, day, 12);

  if (
    Number.isNaN(localDate.getTime()) ||
    localDate.getFullYear() !== year ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day
  ) {
    return null;
  }

  return localDate;
}

function parseInstant(value: string) {
  const instant = new Date(value);

  return Number.isNaN(instant.getTime()) ? null : instant;
}

function formatDateValue(
  value: string,
  formatOptions: Intl.DateTimeFormatOptions,
  valueKind: DateValueKind,
  hasHydrated: boolean,
) {
  const parsedDate = valueKind === "calendar-date" ? parseCalendarDate(value) : parseInstant(value);

  if (!parsedDate) {
    return null;
  }

  const resolvedOptions =
    valueKind === "instant" && !hasHydrated
      ? {
          ...formatOptions,
          timeZone: "UTC",
        }
      : formatOptions;

  return getFormatter(resolvedOptions).format(parsedDate);
}

export function LocalDateTime({
  fallback,
  formatOptions,
  value,
  valueKind = "instant",
  ...props
}: LocalDateTimeProps) {
  const hasHydrated = useHasHydrated();
  const text = formatDateValue(value, formatOptions, valueKind, hasHydrated) ?? fallback ?? value;

  return (
    <time dateTime={value} {...props}>
      {text}
    </time>
  );
}
