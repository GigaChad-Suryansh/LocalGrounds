import { describe, it, expect } from "vitest";
import { cleanName, NAME_MAX, parseClientMessage } from "../src/server";

const loc = { lat: 28.6139, lng: 77.209, accuracyM: 6 };
const create = {
  t: "create",
  name: "Host",
  role: "killer",
  radiusM: 150,
  consent: true,
  location: loc,
};

const bad = (raw: unknown) => {
  const r = parseClientMessage(raw);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.message;
};

describe("client message parsing", () => {
  it("accepts a well-formed create message", () => {
    expect(parseClientMessage(create)).toEqual({ ok: true, msg: create });
  });

  it("requires explicit location consent", () => {
    bad({ ...create, consent: false });
    bad({ ...create, consent: "yes" });
    const { consent: _omit, ...noConsent } = create;
    bad(noConsent);
    bad({ t: "join", code: "ABCDE", name: "Sam", role: "survivor" });
  });

  it("only accepts the radius presets", () => {
    for (const radiusM of [30, 75, 150, 300]) expect(parseClientMessage({ ...create, radiusM }).ok).toBe(true);
    for (const radiusM of [0, 100, 301, -5, "150", NaN, null]) bad({ ...create, radiusM });
  });

  it("requires a usable location and a known role on create", () => {
    bad({ ...create, location: undefined });
    bad({ ...create, location: { lat: "1", lng: 2, accuracyM: 3 } });
    bad({ ...create, location: { lat: 1, lng: 2 } });
    bad({ ...create, role: "spectator" });
  });

  it("cleans display names and rejects empty or overlong ones", () => {
    expect(cleanName("  Sam\u0000  <b>Ray</b>\n ")).toBe("Sam bRay/b");
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("<>")).toBeNull();
    expect(cleanName("x".repeat(NAME_MAX + 1))).toBeNull();
    expect(cleanName("x".repeat(NAME_MAX))).toBe("x".repeat(NAME_MAX));
    expect(cleanName(42)).toBeNull();
    const parsed = parseClientMessage({ ...create, name: " <script> " });
    expect(parsed.ok && parsed.msg.t === "create" ? parsed.msg.name : null).toBe("script");
  });

  it("normalises and validates join codes", () => {
    const ok = parseClientMessage({ t: "join", code: " ab3de ", name: "Sam", role: "survivor", consent: true });
    expect(ok.ok && ok.msg.t === "join" ? ok.msg.code : null).toBe("AB3DE");
    for (const code of ["ABCD", "ABCDEF", "AB CD", "AB-DE", "", 12345, null])
      bad({ t: "join", code, name: "Sam", role: "survivor", consent: true });
  });

  it("validates resume tokens", () => {
    expect(parseClientMessage({ t: "resume", token: "a".repeat(32) }).ok).toBe(true);
    for (const token of ["a".repeat(31), "A".repeat(32), "g".repeat(32), 5, undefined])
      bad({ t: "resume", token });
  });

  it("validates location reports", () => {
    expect(parseClientMessage({ t: "location", report: loc }).ok).toBe(true);
    expect(parseClientMessage({ t: "location", report: { ...loc, ageMs: 1200 } }).ok).toBe(true);
    bad({ t: "location", report: { ...loc, lat: NaN } });
    bad({ t: "location", report: { ...loc, lng: Infinity } });
    bad({ t: "location", report: { ...loc, ageMs: "2" } });
    bad({ t: "location", report: "here" });
    bad({ t: "location" });
  });

  it("does not let a location report smuggle in extra fields (e.g. a timestamp)", () => {
    const r = parseClientMessage({ t: "location", report: { ...loc, timestampMs: 1, role: "killer" } });
    expect(r.ok && r.msg.t === "location" ? Object.keys(r.msg.report).sort() : null).toEqual([
      "accuracyM",
      "lat",
      "lng",
    ]);
  });

  it("validates ready, capture and configure", () => {
    expect(parseClientMessage({ t: "ready", ready: true }).ok).toBe(true);
    bad({ t: "ready", ready: "true" });

    expect(parseClientMessage({ t: "capture", survivorId: "p_ab12cd34" }).ok).toBe(true);
    bad({ t: "capture", survivorId: "../etc" });
    bad({ t: "capture", survivorId: "" });
    bad({ t: "capture", survivorId: "x".repeat(33) });
    bad({ t: "capture" });

    expect(parseClientMessage({ t: "configure", radiusM: 75, captureRadiusM: 12 }).ok).toBe(true);
    expect(parseClientMessage({ t: "configure" }).ok).toBe(true);
    bad({ t: "configure", radiusM: 80 });
    bad({ t: "configure", captureRadiusM: "big" });
  });

  it("captures carry no killer id: the server derives it from the connection", () => {
    const r = parseClientMessage({ t: "capture", survivorId: "p_1", killerId: "p_admin" });
    expect(r.ok && r.msg.t === "capture" ? Object.keys(r.msg).sort() : null).toEqual(["survivorId", "t"]);
  });

  it("accepts the parameterless commands", () => {
    for (const t of ["confirm_safety", "start", "pause", "resume_match", "end", "leave"])
      expect(parseClientMessage({ t })).toEqual({ ok: true, msg: { t } });
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 5, "start", [], [{ t: "start" }], {}, { t: 5 }, { t: "nope" }, { t: "__proto__" }])
      expect(parseClientMessage(junk).ok).toBe(false);
  });
});
