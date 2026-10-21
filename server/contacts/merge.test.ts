import { expect, test } from "bun:test";
import { mergePeople, rankContacts, rankPeople, type Contact, type Person } from "./merge";

const person = (p: Partial<Person>): Person => ({ name: "", title: "", type: "other", contacts: [], ...p });

test("same person from two sources merges, strongest email status wins", () => {
  const a = person({ name: "Priya Sharma", title: "Recruiter", type: "recruiter", contacts: [
    { kind: "linkedin", value: "https://www.linkedin.com/in/priya-s/", source: "research" },
    { kind: "email", value: "priya.sharma@acme.com", status: "guessed", source: "pattern" },
  ] });
  const b = person({ name: "priya  sharma", title: "Senior Talent Acquisition Partner", type: "recruiter", contacts: [
    { kind: "email", value: "Priya.Sharma@acme.com", status: "verified", source: "hunter" },
  ] });
  const [m, ...rest] = mergePeople([[a], [b]]);
  expect(rest).toEqual([]);
  expect(m.title).toBe("Senior Talent Acquisition Partner");
  expect(m.contacts.filter((c) => c.kind === "email")).toEqual([{ kind: "email", value: "priya.sharma@acme.com", status: "verified", source: "hunter" }]);
});

test("same LinkedIn URL merges even with different name spellings", () => {
  const li = (v: string): Contact => ({ kind: "linkedin", value: v, source: "x" });
  const out = mergePeople([[person({ name: "Priya S.", contacts: [li("https://linkedin.com/in/priya-s?trk=1")] })], [person({ name: "Priya Sharma", contacts: [li("https://www.linkedin.com/in/priya-s/")] })]]);
  expect(out.length).toBe(1);
});

test("contacts ordered phone, email by strength, linkedin, x, inbox", () => {
  const c: Contact[] = [
    { kind: "inbox", value: "careers@acme.com", source: "site" },
    { kind: "linkedin", value: "https://linkedin.com/in/p", source: "r" },
    { kind: "email", value: "g@acme.com", status: "guessed", source: "pattern" },
    { kind: "email", value: "v@acme.com", status: "verified", source: "hunter" },
    { kind: "x", value: "https://x.com/p", source: "r" },
    { kind: "phone", value: "+919876543210", status: "published", source: "post" },
  ];
  expect(rankContacts(c).map((x) => x.value)).toEqual(["+919876543210", "v@acme.com", "g@acme.com", "https://linkedin.com/in/p", "https://x.com/p", "careers@acme.com"]);
});

test("recruiters before founders; more contacts break ties", () => {
  const out = rankPeople([
    person({ name: "F", type: "founder" }),
    person({ name: "R1", type: "recruiter" }),
    person({ name: "R2", type: "recruiter", contacts: [{ kind: "x", value: "x", source: "s" }] }),
  ]);
  expect(out.map((p) => p.name)).toEqual(["R2", "R1", "F"]);
});
