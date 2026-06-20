import { describe, expect, it } from "vitest";
import { normalizeForConflict } from "./db";

describe("normalizeForConflict — conflict-matching name normalization", () => {
  it("lower-cases and collapses whitespace", () => {
    expect(normalizeForConflict("  Acme   HOLDINGS  ")).toBe("acme holdings");
  });

  it("treats punctuation as a separator so hyphen/space variants align", () => {
    const a = normalizeForConflict("Al-Futtaim");
    const b = normalizeForConflict("Al Futtaim");
    expect(a).toBe(b);
    expect(a).toBe("al futtaim");
  });

  it("normalizes Arabic punctuation (comma/semicolon) like Latin punctuation", () => {
    expect(normalizeForConflict("الفطيم، ش.م.ع")).toBe(normalizeForConflict("الفطيم ش م ع"));
  });

  it("normalizes alef variants, taa-marbuta and alef-maksura", () => {
    // أحمد / احمد and شركة / شركه should collapse to the same canonical form
    expect(normalizeForConflict("أحمد")).toBe(normalizeForConflict("احمد"));
    expect(normalizeForConflict("شركة")).toBe(normalizeForConflict("شركه"));
  });

  it("strips Arabic diacritics (tashkeel)", () => {
    expect(normalizeForConflict("مُحَمَّد")).toBe(normalizeForConflict("محمد"));
  });

  it("maps Arabic-Indic digits to Latin digits", () => {
    expect(normalizeForConflict("ملف ٢٠٢٤")).toBe("ملف 2024");
  });

  it("returns empty string for blank / punctuation-only input", () => {
    expect(normalizeForConflict("   ")).toBe("");
    expect(normalizeForConflict("-,.")).toBe("");
  });

  it("keeps a substring relationship usable for conservative containment", () => {
    const needle = normalizeForConflict("Al-Futtaim");
    expect(normalizeForConflict("Al Futtaim Group LLC").includes(needle)).toBe(true);
  });
});
