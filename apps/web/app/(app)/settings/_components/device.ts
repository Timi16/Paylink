/** Short "Chrome on macOS"-style label from a User-Agent header. */
export function describeDevice(userAgent: string | null): { label: string; mobile: boolean } {
  const ua = userAgent ?? "";

  // Order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari".
  let browser: string | null = null;
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser\//.test(ua)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = "Safari";

  let os: string | null = null;
  if (/iPhone|iPod/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  const mobile = os === "iPhone" || os === "Android" || /Mobile/.test(ua);
  if (browser && os) return { label: `${browser} on ${os}`, mobile };
  return { label: browser ?? os ?? "Unknown device", mobile };
}

export const DEVICE_ICON = {
  desktop: "M3 5h18v11H3zM8 20h8M12 16v4",
  mobile: "M7 3h10v18H7zM11 18h2",
} as const;
