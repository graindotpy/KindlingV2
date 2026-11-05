import { UnlockScreen } from "@/app/unlock/unlock-screen";

function normalizeNextPath(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(candidate)) {
    return "/";
  }

  const next = new URL(candidate, "https://kindling.invalid");
  // Never return to the unlock screen after a successful sign-in.
  return next.pathname.replace(/\/+$/, "") === "/unlock" ? "/" : `${next.pathname}${next.search}${next.hash}`;
}

export default async function UnlockPage(props: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const searchParams = await props.searchParams;
  return <UnlockScreen nextPath={normalizeNextPath(searchParams.next)} />;
}
