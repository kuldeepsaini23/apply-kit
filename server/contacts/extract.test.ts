import { expect, test } from "bun:test";
import { applyPattern, extractEmails, extractPhones, inferPattern, isRoleInbox, normName } from "./extract";

test("emails filtered to domain, noise dropped", () => {
  expect(extractEmails("Mail priya.s@acme.com or a@other.com, logo@2x.png, x@sentry.io", "acme.com")).toEqual(["priya.s@acme.com"]);
});

test("emails keep subdomains and dedupe case-insensitively", () => {
  expect(extractEmails("Priya.S@Acme.com, priya.s@acme.com, ops@in.acme.com", "acme.com")).toEqual(["priya.s@acme.com", "ops@in.acme.com"]);
});

test("emails without a domain drop noise only", () => {
  expect(extractEmails("a@other.com b@example.com c@wixpress.com")).toEqual(["a@other.com"]);
});

test("role inboxes", () => {
  expect(isRoleInbox("careers@acme.com")).toBe(true);
  expect(isRoleInbox("recruitment@acme.com")).toBe(true);
  expect(isRoleInbox("priya.sharma@acme.com")).toBe(false);
});

test("indian phones normalise; non-phones ignored", () => {
  expect(extractPhones("WhatsApp +91 98765 43210 or 098765-43211, call 9876543212")).toEqual(["+919876543210", "+919876543211", "+919876543212"]);
  expect(extractPhones("Order 2026101298765 costs ₹12,999 on 21-10-2026")).toEqual([]);
});

test("international numbers with a plus are kept", () => {
  expect(extractPhones("US office +1 415 555 0134")).toEqual(["+14155550134"]);
});

test("pattern inferred from named pairs, role inbox ignored", () => {
  const pairs = [
    { name: "Priya Sharma", email: "priya.sharma@acme.com" },
    { name: "Rahul Verma", email: "rahul.verma@acme.com" },
    { name: "Acme", email: "careers@acme.com" },
  ];
  expect(inferPattern(pairs, "acme.com")).toEqual({ pattern: "first.last", matches: 2 });
});

test("no pattern when nothing matches", () => {
  expect(inferPattern([{ name: "Priya Sharma", email: "ps123@acme.com" }], "acme.com")).toBeNull();
});

test("apply pattern", () => {
  expect(applyPattern("flast", "Ankit Kumar Jain", "acme.com")).toBe("ajain@acme.com");
  expect(applyPattern("first.last", "José Núñez", "acme.com")).toBe("jose.nunez@acme.com");
  expect(applyPattern("first", "Priya", "acme.com")).toBe("priya@acme.com");
  expect(applyPattern("first.last", "Priya", "acme.com")).toBe("");
});

test("titles like Dr and Prof are not part of the name", () => {
  expect(applyPattern("first", "Dr. Pratyush Kumar", "acme.com")).toBe("pratyush@acme.com");
  expect(applyPattern("first.last", "Prof Anil Mehta PhD", "acme.com")).toBe("anil.mehta@acme.com");
});

test("normName folds case, accents and spaces", () => {
  expect(normName("  José   Núñez ")).toBe("jose nunez");
});
