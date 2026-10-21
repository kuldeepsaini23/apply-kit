import type { Fetch } from "./sources";

// Fake fetch from a URL → body map (objects become JSON); anything else is a 404.
export function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f: Fetch = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url === k || url.startsWith(k + "?"));
    if (key === undefined) return new Response("not found", { status: 404 });
    const body = routes[key];
    if (body instanceof Error) throw body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
  return { f, calls };
}
